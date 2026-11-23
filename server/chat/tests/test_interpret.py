import json

import pytest

from chat.interpret import interpret_note
from chat.providers import GeminiProvider, OpenAIProvider

LEG = {"id": "seed-leg-press", "name": "Leg Press", "type": "machine"}
BENCH = {"id": "seed-bench", "name": "Barbell Bench Press", "type": "barbell"}


def payload(note, workout=None, exercises=None):
    return {
        "note": note,
        "consent": True,
        "contextRevision": "w1:open" if workout else "none",
        "workout": workout,
        "exercises": exercises if exercises is not None else [LEG, BENCH],
    }


def test_leg_day_starts_a_workout():
    result = interpret_note(payload("It's leg day today"))
    assert result["status"] == "proposal"
    assert result["proposal"] == {"kind": "start_workout", "label": "Leg Day"}


def test_leg_day_resumes_the_open_workout():
    result = interpret_note(payload("It's leg day today", {"id": "w1", "label": "Leg Day", "ended": False}))
    assert result["proposal"]["kind"] == "resume_workout"
    assert result["proposal"]["workoutId"] == "w1"


def test_different_open_workout_asks_instead_of_starting_another():
    result = interpret_note(payload("It's leg day today", {"id": "w1", "label": "Push", "ended": False}))
    assert result["status"] == "clarify"
    assert result["reason"] == "workout"


def test_leg_press_set():
    result = interpret_note(payload("Leg press 100 x 10", {"id": "w1", "label": "Leg Day", "ended": False}))
    assert result["proposal"]["kind"] == "log_set"
    assert result["proposal"]["exerciseId"] == "seed-leg-press"
    assert result["proposal"]["loadLb"] == "100"
    assert result["proposal"]["reps"] == 10


def test_two_presses_need_a_choice():
    result = interpret_note(payload("press 100 x 10", {"id": "w1", "label": "Leg Day", "ended": False}))
    assert result["status"] == "clarify"
    assert result["reason"] == "exercise"


def test_hypothetical_note_is_not_a_set():
    result = interpret_note(payload("what if I leg press 100 x 10", {"id": "w1", "label": "Leg Day", "ended": False}))
    assert result["reason"] == "intent"


def test_missing_reps_asks_for_them():
    result = interpret_note(payload("leg press 100", {"id": "w1", "label": "Leg Day", "ended": False}))
    assert result["reason"] == "reps"


def test_openai_provider_reads_stubbed_json():
    proposal = {
        "version": 1,
        "status": "proposal",
        "contextRevision": "w1:open",
        "proposal": {
            "kind": "log_set",
            "workoutId": "w1",
            "exerciseId": "seed-leg-press",
            "exerciseName": "Leg Press",
            "loadLb": "100",
            "reps": 10,
            "assisted": False,
        },
    }

    def transport(url, body, headers):
        assert headers["Authorization"] == "Bearer test-key"
        assert "Health" not in json.dumps(body)
        return {"choices": [{"message": {"content": json.dumps(proposal)}}]}

    result = OpenAIProvider("test-key", "gpt-4o-mini", "https://example.test/v1", transport).interpret(
        payload("Leg press 100 x 10", {"id": "w1", "label": "Leg Day", "ended": False})
    )
    assert result["proposal"]["exerciseId"] == "seed-leg-press"


def test_actions_wrapper_is_rejected_and_gemini_accepts_single_proposal():
    from chat.interpret import parse_model_content
    with pytest.raises(ValueError):
        parse_model_content(json.dumps({
            "version": 1, "status": "proposal", "contextRevision": "none",
            "proposal": {"actions": [{"kind": "start_workout", "label": "Leg Day"}]},
        }))
    proposal = {
        "version": 1,
        "status": "proposal",
        "contextRevision": "none",
        "proposal": {"kind": "start_workout", "label": "Leg Day"},
    }

    def transport(url, body, headers):
        assert "generativelanguage.googleapis.com" in url
        assert "key=" not in url
        assert headers["x-goog-api-key"] == "test-key"
        assert "Health" not in json.dumps(body)
        return {"candidates": [{"content": {"parts": [{"text": json.dumps(proposal)}]}}]}

    result = GeminiProvider("test-key", "gemini-2.5-flash", transport).interpret(payload("doing legs today"))
    assert result["proposal"]["label"] == "Leg Day"


@pytest.mark.django_db
def test_endpoint_requires_consent_and_uses_the_fake_when_asked(monkeypatch, auth_client):
    monkeypatch.setenv("CHAT_PROVIDER", "fake")
    client = auth_client
    denied = client.post("/api/v1/chat/interpret", {"note": "It's leg day today", "consent": False}, format="json")
    assert denied.status_code == 400
    allowed = client.post(
        "/api/v1/chat/interpret",
        payload("It's leg day today"),
        format="json",
    )
    assert allowed.status_code == 200
    assert allowed.json()["proposal"]["label"] == "Leg Day"


def test_transport_identifies_the_client(monkeypatch):
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, limit):
            return b'{"ok": true}'

    def fake_urlopen(request, timeout):
        captured["agent"] = request.get_header("User-agent")
        captured["auth"] = request.get_header("Authorization")
        return Response()

    class Opener:
        open = staticmethod(fake_urlopen)

    monkeypatch.setattr("urllib.request.build_opener", lambda *args: Opener())
    from chat.providers import _post_json

    assert _post_json("https://example.test/v1/chat/completions", {"a": 1}, {"Authorization": "Bearer placeholder"}) == {"ok": True}
    assert captured["agent"] == "liftlog-course/1.0"
    assert captured["auth"] == "Bearer placeholder"


def test_groq_is_explicit_and_reports_malformed_rate_limit_and_timeout(monkeypatch):
    import urllib.error
    from chat.providers import get_provider

    monkeypatch.setenv("GROQ_API_KEY", "placeholder-not-a-real-key")
    monkeypatch.delenv("CHAT_PROVIDER", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    assert get_provider().name == "fake"

    proposal = {
        "version": 1,
        "status": "proposal",
        "contextRevision": "none",
        "proposal": {"kind": "start_workout", "label": "Leg Day"},
    }

    def transport(url, body, headers):
        assert url == "https://api.groq.com/openai/v1/chat/completions"
        assert body["model"] == "openai/gpt-oss-120b"
        assert body["response_format"]["type"] == "json_schema"
        assert headers["Authorization"] == "Bearer placeholder-not-a-real-key"
        assert "Health" not in json.dumps(body)
        return {"choices": [{"message": {"content": json.dumps(proposal)}}]}

    provider = OpenAIProvider(
        "placeholder-not-a-real-key",
        "openai/gpt-oss-120b",
        "https://api.groq.com/openai/v1",
        transport,
        response_format={"type": "json_schema", "json_schema": {"name": "liftlog_interpret", "schema": {}}},
    )
    assert provider.interpret(payload("doing legs today"))["proposal"]["label"] == "Leg Day"

    def malformed(url, body, headers):
        return {"choices": [{"message": {"content": "not json"}}]}

    bad = OpenAIProvider("placeholder-not-a-real-key", "openai/gpt-oss-120b", "https://api.groq.com/openai/v1", malformed)
    with pytest.raises(Exception) as error:
        bad.interpret(payload("doing legs today"))
    assert error.value.code == "malformed"

    def rate_limit(url, body, headers):
        raise urllib.error.HTTPError("https://api.groq.com/openai/v1/chat/completions", 429, "Too Many Requests", None, None)

    limited = OpenAIProvider("placeholder-not-a-real-key", "openai/gpt-oss-120b", "https://api.groq.com/openai/v1", rate_limit)
    with pytest.raises(Exception) as limited_error:
        limited.interpret(payload("doing legs today"))
    assert limited_error.value.code == "rate_limited"

    def timed_out(url, body, headers):
        raise TimeoutError("timed out")

    slow = OpenAIProvider("placeholder-not-a-real-key", "openai/gpt-oss-120b", "https://api.groq.com/openai/v1", timed_out)
    with pytest.raises(Exception) as timeout_error:
        slow.interpret(payload("doing legs today"))
    assert timeout_error.value.code == "timeout"
