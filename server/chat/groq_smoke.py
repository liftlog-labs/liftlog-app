"""Synthetic Groq smoke test. Run from the server directory:

.venv/bin/python -m chat.groq_smoke
"""

import json
import os
import sys

from config.env import load_local_env
from chat.providers import OpenAIProvider, groq_response_format

load_local_env()

SYNTHETIC = {
    "note": "doing legs today",
    "consent": True,
    "contextRevision": "none",
    "workout": None,
    "exercises": [
        {"id": "seed-leg-press", "name": "Leg Press", "type": "machine"},
        {"id": "seed-bench", "name": "Barbell Bench Press", "type": "barbell"},
    ],
}


def main() -> int:
    key = os.environ.get("GROQ_API_KEY", "")
    if not key:
        print("pending: GROQ_API_KEY is not set")
        return 0
    provider = OpenAIProvider(
        api_key=key,
        model=os.environ.get("MODEL_NAME", "openai/gpt-oss-120b"),
        base_url=os.environ.get("MODEL_BASE_URL", "https://api.groq.com/openai/v1"),
        response_format=groq_response_format(),
    )
    try:
        result = provider.interpret(SYNTHETIC)
    except Exception as error:
        print(f"failed: {error.code if hasattr(error, 'code') else 'unavailable'}")
        return 1
    print(json.dumps({"provider": provider.name, "model": provider.model, "result": result}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
