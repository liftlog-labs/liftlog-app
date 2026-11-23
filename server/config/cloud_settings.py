"""Explicit settings for the API-only staging and production services."""
import os
import re
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from config.settings import *  # noqa: F403
from config.postgres import postgres_database


def required(name):
    value = os.environ.get(name)
    if not value:
        raise ImproperlyConfigured(f"{name} is required.")
    return value


ENVIRONMENT = required("LIFTLOG_ENV")
if ENVIRONMENT not in {"staging", "production"}:
    raise ImproperlyConfigured("LIFTLOG_ENV must be staging or production.")

SECRET_KEY = required("DJANGO_SECRET_KEY")
if len(SECRET_KEY) < 50 or len(set(SECRET_KEY)) < 20 or SECRET_KEY.startswith("django-insecure-"):
    raise ImproperlyConfigured("Generate a random Django secret of at least 50 characters.")
DEBUG = False
LIFTLOG_LOCAL_DEV_OPEN = False

ALLOWED_HOSTS = required("DJANGO_ALLOWED_HOSTS").split(",")
if any(not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}", host)
       for host in ALLOWED_HOSTS):
    raise ImproperlyConfigured("Use comma-separated exact HTTPS DNS hostnames.")
CSRF_TRUSTED_ORIGINS = [f"https://{host}" for host in ALLOWED_HOSTS]
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
# Render's internal health probe may connect using HTTP.
SECURE_REDIRECT_EXEMPT = [r"^healthz$", r"^readyz$"]
SECURE_HSTS_SECONDS = 31536000 if ENVIRONMENT == "production" else 300
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
X_FRAME_OPTIONS = "DENY"
SESSION_ENGINE = "django.contrib.sessions.backends.db"

DATABASES = {"default": postgres_database(required("DATABASE_URL"), sslmode="require")}
_cache_url = required("REDIS_URL")
if urlsplit(_cache_url).scheme not in {"redis", "rediss"} or not urlsplit(_cache_url).hostname:
    raise ImproperlyConfigured("Set the private Redis-compatible URL.")
CACHES = {"default": {
    "BACKEND": "django.core.cache.backends.redis.RedisCache",
    "LOCATION": _cache_url,
    "KEY_PREFIX": f"liftlog-{ENVIRONMENT}",
    "OPTIONS": {"socket_connect_timeout": 2, "socket_timeout": 2},
}}
MIDDLEWARE = [
    "config.dev_https_middleware.ExactHostMiddleware",
    *[item for item in MIDDLEWARE if item != "accounts.limits.RegistrationAttemptLimit"],  # noqa: F405
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.cloud_urls"
DATA_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
REST_FRAMEWORK = {
    **REST_FRAMEWORK,  # noqa: F405
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}
_provider = required("CHAT_PROVIDER")
if _provider not in ({"groq"} if ENVIRONMENT == "production" else {"fake", "groq"}):
    raise ImproperlyConfigured("Production requires Groq. Staging supports fake or Groq.")
if _provider == "groq":
    required("GROQ_API_KEY")
    from chat.policy import provider_config
    provider_config()
