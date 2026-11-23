import json
import os
import urllib.error
import urllib.request

from chat.interpret import interpret_note, parse_model_content

SYSTEM_PROMPT = """You interpret one lifter's message for the Liftlog app.
Return only JSON, no markdown, with this shape:
{"version":1,"status":"proposal","contextRevision":"<echo>","proposal":{...}}
or
{"version":1,"status":"clarify","contextRevision":"<echo>","question":"...","reason":"exercise"|"reps"|"intent"|"workout"}

Rules:
- Pounds only. A completed set uses kind log_set with an exerciseId copied from the catalog, loadLb as a number string, reps as an integer, assisted false unless they say they had help.
- Match casual names to the closest catalog exercise. "leg press" is Leg Press. "bench" is Barbell Bench Press. If two catalog exercises fit, clarify instead of guessing.
- "It's leg day", "doing legs today", or "leg day" with no open workout is start_workout with label "Leg Day". If that label is already open, resume_workout with its id. If a different workout is open, clarify and do not start a second one.
- Log a set only when they report work they completed. Hypothetical or planning wording ("what if", "maybe", "should I", "I might") is clarify reason intent, never a set.
- Missing weight or reps is clarify reason reps. Do not invent numbers.
- Echo contextRevision from the user payload. Use only exercise ids from that payload. Never include health data.
- proposal must be one object with a kind field, never an actions array.
"""


class ProviderError(Exception):
    def __init__(self, message: str, code: str = "unavailable"):
        super().__init__(message)
        self.code = code


class FakeProvider:
    name = "fake"

    def interpret(self, payload: dict) -> dict:
        return interpret_note(payload)


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str, model: str, base_url: str, transport=None, response_format=None):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.transport = transport or _post_json
        self.response_format = response_format or {"type": "json_object"}

    def interpret(self, payload: dict) -> dict:
        body = {
            "model": self.model,
            "max_tokens": 512,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(_model_input(payload))},
            ],
            "response_format": self.response_format,
        }
        try:
            data = self.transport(
                f"{self.base_url}/chat/completions",
                body,
                {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            )
            content = data["choices"][0]["message"]["content"]
            return parse_model_content(content, payload)
        except urllib.error.HTTPError as error:
            code = "rate_limited" if error.code == 429 else "unavailable"
            raise ProviderError("The model request was not completed", code) from error
        except TimeoutError as error:
            raise ProviderError("The model request timed out", "timeout") from error
        except (KeyError, ValueError, TypeError, urllib.error.URLError) as error:
            raise ProviderError("The model did not return a usable proposal", "malformed") from error


class GeminiProvider:
    name = "gemini"

    def __init__(self, api_key: str, model: str, transport=None):
        self.api_key = api_key
        self.model = model
        self.transport = transport or _post_json

    def interpret(self, payload: dict) -> dict:
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent"
        )
        body = {
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [{"role": "user", "parts": [{"text": json.dumps(_model_input(payload))}]}],
            "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json", "maxOutputTokens": 512},
        }
        try:
            data = self.transport(url, body, {"Content-Type": "application/json", "x-goog-api-key": self.api_key})
            parts = data["candidates"][0]["content"]["parts"]
            content = "".join(part.get("text", "") for part in parts)
            return parse_model_content(content, payload)
        except (KeyError, ValueError, TypeError, urllib.error.URLError) as error:
            raise ProviderError("The model did not return a usable proposal") from error


def get_provider():
    from chat.policy import provider_config
    config = provider_config()
    choice = config['choice']
    if choice == 'fake':
        return FakeProvider()
    if choice == 'gemini':
        key = os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY')
        if not key:
            raise ProviderError('Provider key is not configured')
        return GeminiProvider(key, config['model'])
    key = os.environ.get('GROQ_API_KEY') if choice == 'groq' else os.environ.get('MODEL_API_KEY') or os.environ.get('OPENAI_API_KEY')
    if not key:
        raise ProviderError('Provider key is not configured')
    provider = OpenAIProvider(key, config['model'], config['destination'], response_format=groq_response_format() if choice == 'groq' else None)
    provider.name = choice
    return provider


def groq_response_format() -> dict:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "liftlog_interpret",
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["version", "status", "contextRevision"],
                "properties": {
                    "version": {"type": "integer"},
                    "status": {"type": "string", "enum": ["proposal", "clarify"]},
                    "contextRevision": {"type": "string"},
                    "question": {"type": "string"},
                    "reason": {"type": "string"},
                    "proposal": {"type": "object"},
                },
            },
        },
    }


def _model_input(payload: dict) -> dict:
    return {
        "note": payload.get("note"),
        "contextRevision": payload.get("contextRevision"),
        "workout": payload.get("workout"),
        "exercises": payload.get("exercises"),
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProviderError("Provider redirects are disabled")


def _post_json(url: str, body: dict, headers: dict) -> dict:
    headers = {"User-Agent": "liftlog-course/1.0", **headers}
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=20) as response:
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ProviderError("Provider response too large", "malformed")
        return json.loads(raw.decode())
