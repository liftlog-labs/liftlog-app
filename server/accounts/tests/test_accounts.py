import hashlib
import json
import logging
import uuid
from datetime import timedelta

import pytest
from django.contrib.auth.models import User
from django.test import override_settings
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.test import APIClient

from accounts.exceptions import safe_exception_handler
from accounts.models import AccountProfile, AuthSession
from accounts.redact import redact
from records.models import CloudConsent

PASSWORD = "Liftlog-Test-Pass-1"
CLOSED = override_settings(DEBUG=True, LIFTLOG_LOCAL_DEV_OPEN=False)


@pytest.fixture(autouse=True)
def clear_login_attempts():
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


def register(client, email, display_name="Lifter"):
    return client.post(
        "/api/v1/auth/register",
        {"email": email, "password": PASSWORD, "displayName": display_name},
        format="json",
    )


@pytest.mark.django_db
def test_register_and_login_return_a_session_without_the_password():
    client = APIClient()
    created = register(client, "A@Example.com", "Ada")
    assert created.status_code == 201
    body = created.json()
    account = body["account"]
    assert account["email"] == "a@example.com"
    assert account["displayName"] == "Ada"
    assert account["revision"] == 1
    assert account["cloudSyncConsent"] is None
    uuid.UUID(account["accountId"])
    assert "password" not in json.dumps(body).lower()
    session = AuthSession.objects.get()
    assert session.token_hash != body["token"]
    assert session.user.check_password(PASSWORD)

    client.credentials()
    signed_in = client.post(
        "/api/v1/auth/login",
        {"email": "a@example.com", "password": PASSWORD},
        format="json",
    )
    assert signed_in.status_code == 200
    assert signed_in.json()["token"] != body["token"]
    assert signed_in.json()["account"]["accountId"] == account["accountId"]
    assert PASSWORD not in json.dumps(signed_in.json())
    assert signed_in.json()["account"]["cloudSyncConsent"] is None
    assert CloudConsent.objects.count() == 0


@pytest.mark.django_db
def test_unknown_email_and_wrong_password_match_and_logs_omit_secrets(caplog):
    client = APIClient()
    register(client, "ada@example.com")
    with caplog.at_level(logging.INFO, logger="accounts.service"):
        unknown = client.post(
            "/api/v1/auth/login",
            {"email": "missing@example.com", "password": "not-the-password"},
            format="json",
        )
        wrong = client.post(
            "/api/v1/auth/login",
            {"email": "ada@example.com", "password": "still-not-the-password"},
            format="json",
        )
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json() == {"code": "INVALID_CREDENTIALS"}
    assert "not-the-password" not in caplog.text
    assert "still-not-the-password" not in caplog.text


@pytest.mark.django_db
def test_login_failures_are_rate_limited():
    from django.core.cache import cache

    cache.clear()
    client = APIClient()
    register(client, "ada@example.com")
    for _ in range(5):
        failed = client.post(
            "/api/v1/auth/login",
            {"email": "ada@example.com", "password": "wrong-password"},
            format="json",
        )
        assert failed.status_code == 401
    blocked = client.post(
        "/api/v1/auth/login",
        {"email": "ada@example.com", "password": PASSWORD},
        format="json",
    )
    assert blocked.status_code == 429
    assert blocked.json() == {"code": "RATE_LIMITED"}
    assert PASSWORD not in json.dumps(blocked.json())


@pytest.mark.django_db
def test_rejects_privilege_fields_and_weak_passwords_without_echoing_them():
    client = APIClient()
    forged = client.post(
        "/api/v1/auth/register",
        {"email": "ada@example.com", "password": PASSWORD, "displayName": "Ada", "is_staff": True},
        format="json",
    )
    assert forged.status_code == 400
    assert forged.json() == {"code": "INVALID_INPUT"}
    assert User.objects.count() == 0

    weak = client.post(
        "/api/v1/auth/register",
        {"email": "ada@example.com", "password": "password123", "displayName": "Ada"},
        format="json",
    )
    assert weak.status_code == 400
    assert weak.json()["code"] == "INVALID_PASSWORD"
    assert "password123" not in json.dumps(weak.json())


@pytest.mark.django_db
@CLOSED
def test_anonymous_requests_are_rejected():
    client = APIClient()
    account = client.get("/api/v1/account")
    trends = client.post("/api/v1/analytics/trends", {}, format="json")
    chat = client.post("/api/v1/chat/interpret", {"note": "leg day", "consent": False}, format="json")
    assert account.status_code == trends.status_code == chat.status_code == 401
    assert account.json() == trends.json() == chat.json() == {"code": "UNAUTHENTICATED"}


@pytest.mark.django_db
@CLOSED
def test_cross_account_and_forged_owner_ids_do_not_write(auth_client):
    other = APIClient()
    created = register(other, "other@example.com", "Other")
    other_id = User.objects.get(email="other@example.com").id
    forged = auth_client.patch(
        "/api/v1/account",
        {"displayName": "Stolen", "baseRevision": 1, "userId": other_id},
        format="json",
    )
    assert forged.status_code == 400
    assert AccountProfile.objects.get(user__email="trend@example.com").display_name == "Trend"
    assert AccountProfile.objects.get(user__email="other@example.com").display_name == "Other"

    queried = auth_client.get(f"/api/v1/account?userId={other_id}")
    assert queried.status_code == 200
    assert queried.json()["email"] == "trend@example.com"
    assert created.json()["account"]["email"] == "other@example.com"


@pytest.mark.django_db
def test_profile_conflict_keeps_the_server_row_and_returns_both_values(auth_client):
    saved = auth_client.patch(
        "/api/v1/account",
        {"displayName": "Updated", "baseRevision": 1},
        format="json",
    )
    assert saved.status_code == 200
    assert saved.json()["revision"] == 2

    conflict = auth_client.patch(
        "/api/v1/account",
        {"displayName": "From a stale device", "baseRevision": 1},
        format="json",
    )
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "CONFLICT"
    assert conflict.json()["server"]["displayName"] == "Updated"
    assert conflict.json()["rejected"]["displayName"] == "From a stale device"
    profile = AccountProfile.objects.get(user__email="trend@example.com")
    assert profile.display_name == "Updated"
    assert profile.revision == 2


@pytest.mark.django_db
@CLOSED
def test_expired_revoked_and_logged_out_credentials_fail():
    client = APIClient()
    first = register(client, "ada@example.com")
    second = client.post(
        "/api/v1/auth/login",
        {"email": "ada@example.com", "password": PASSWORD},
        format="json",
    )
    first_token = first.json()["token"]
    second_token = second.json()["token"]

    expired = AuthSession.objects.get(token_hash=hashlib.sha256(first_token.encode()).hexdigest())
    expired.expires_at = timezone.now() - timedelta(seconds=1)
    expired.save(update_fields=["expires_at"])
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {first_token}")
    assert client.get("/api/v1/account").status_code == 401
    assert first_token not in client.get("/api/v1/account").content.decode()

    client.credentials(HTTP_AUTHORIZATION=f"Bearer {second_token}")
    assert client.get("/api/v1/account").status_code == 200
    logged_out = client.post("/api/v1/auth/logout")
    assert logged_out.status_code == 204
    assert logged_out.content == b""
    assert client.get("/api/v1/account").status_code == 401
    assert client.post("/api/v1/auth/logout").status_code == 401

    client.credentials()
    assert client.get(f"/api/v1/account?token={second_token}").status_code == 401


@pytest.mark.django_db
@CLOSED
def test_chat_does_not_persist_the_note(auth_client, monkeypatch):
    monkeypatch.setenv("CHAT_PROVIDER", "fake")
    marker = "note-should-not-be-stored-xyz"
    response = auth_client.post(
        "/api/v1/chat/interpret",
        {
            "note": marker,
            "consent": True,
            "contextRevision": "none",
            "workout": None,
            "exercises": [{"id": "seed-leg-press", "name": "Leg Press", "type": "machine"}],
        },
        format="json",
    )
    assert response.status_code == 200
    from django.apps import apps

    for model in apps.get_models():
        for row in model.objects.values():
            assert marker not in json.dumps(row, default=str)


@override_settings(DEBUG=True, LIFTLOG_LOCAL_DEV_OPEN=True)
@pytest.mark.django_db
def test_local_dev_open_allows_anonymous_trends_only_while_debug_is_on():
    client = APIClient()
    opened = client.post(
        "/api/v1/analytics/trends",
        {"range": {"start": "2026-10-01", "end": "2026-10-14"}, "workouts": []},
        format="json",
    )
    assert opened.status_code == 200


@override_settings(DEBUG=False, LIFTLOG_LOCAL_DEV_OPEN=True)
@pytest.mark.django_db
def test_local_dev_flag_stays_closed_when_debug_is_off():
    client = APIClient()
    closed = client.post(
        "/api/v1/analytics/trends",
        {"range": {"start": "2026-10-01", "end": "2026-10-14"}, "workouts": []},
        format="json",
    )
    assert closed.status_code == 401
    assert closed.json() == {"code": "UNAUTHENTICATED"}


def test_errors_and_logs_redact_secrets():
    hidden = redact('Authorization: Bearer abcdefghijklmnop password="SuperSecret" token=raw-token')
    assert "abcdefghijklmnop" not in hidden
    assert "SuperSecret" not in hidden
    assert "raw-token" not in hidden

    response = safe_exception_handler(RuntimeError('password="SuperSecret"'), {})
    assert response.status_code == 500
    assert response.data == {"code": "ERROR"}
    failed = safe_exception_handler(AuthenticationFailed("Bearer abcdefghijklmnop"), {})
    assert failed.status_code == 401
    assert failed.data == {"code": "UNAUTHENTICATED"}


@pytest.mark.django_db
def test_registration_records_explicit_cloud_consent_and_login_preserves_it():
    client = APIClient()
    response = client.post(
        "/api/v1/auth/register",
        {"email": "consent@example.com", "password": PASSWORD, "cloudSyncConsent": "2026-11-05"},
        format="json",
    )
    assert response.status_code == 201
    assert response.json()["account"]["cloudSyncConsent"] == "2026-11-05"
    consent = CloudConsent.objects.get(owner__email="consent@example.com")
    assert consent.version == "2026-11-05"
    assert consent.accepted_at is not None
    signed_in = client.post(
        "/api/v1/auth/login", {"email": "consent@example.com", "password": PASSWORD}, format="json"
    )
    assert signed_in.status_code == 200
    assert signed_in.json()["account"]["cloudSyncConsent"] == "2026-11-05"
    assert CloudConsent.objects.count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize("version", [None, "", "2026-11-04", True, {"cloudSync": "2026-11-05"}])
def test_registration_rejects_invalid_explicit_consent_without_creating_account(version):
    response = APIClient().post(
        "/api/v1/auth/register",
        {"email": "consent@example.com", "password": PASSWORD, "cloudSyncConsent": version},
        format="json",
    )
    assert response.status_code == 400
    assert response.json() == {"code": "INVALID_INPUT"}
    assert User.objects.count() == AccountProfile.objects.count() == CloudConsent.objects.count() == 0


@pytest.mark.django_db
def test_registration_rolls_back_account_if_consent_cannot_be_saved(monkeypatch):
    from django.db import IntegrityError

    attempts = []

    def fail_consent(*args, **kwargs):
        attempts.append(kwargs)
        raise IntegrityError("synthetic consent failure")

    monkeypatch.setattr(CloudConsent.objects, "create", fail_consent)
    response = APIClient().post(
        "/api/v1/auth/register",
        {"email": "consent@example.com", "password": PASSWORD, "cloudSyncConsent": "2026-11-05"},
        format="json",
    )
    assert response.status_code == 400
    assert len(attempts) == 1
    assert User.objects.count() == AccountProfile.objects.count() == AuthSession.objects.count() == 0
