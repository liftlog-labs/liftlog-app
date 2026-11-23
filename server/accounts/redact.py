import logging
import re

_BEARER = re.compile(r"(?i)\bBearer\s+\S+")
_SECRET_FIELD = re.compile(
    r"(?i)(password|token|authorization|api_key|secret)\s*[=:]\s*(\"[^\"]*\"|'[^']*'|\S+)"
)


def redact(message: str) -> str:
    message = _BEARER.sub("Bearer [redacted]", message)
    return _SECRET_FIELD.sub(lambda match: f"{match.group(1)}=[redacted]", message)


class RedactSecrets(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = ()
        return True
