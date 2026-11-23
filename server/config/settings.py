import os
from pathlib import Path

from config.env import load_local_env

load_local_env()

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "local-course-only-not-for-production")
DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"
ALLOWED_HOSTS = [host.strip() for host in os.environ.get(
    "DJANGO_ALLOWED_HOSTS", "127.0.0.1,localhost,10.0.2.2"
).split(",") if host.strip()]
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.sessions",
    "journal",
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "rest_framework",
    "accounts",
    "records",
    "analytics",
    "chat",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "accounts.limits.RegistrationAttemptLimit",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
]
ROOT_URLCONF = "config.urls"
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.auth.context_processors.auth",
    ]},
}]
LOGIN_URL = "/login/"
LOGIN_REDIRECT_URL = "/"
LOGOUT_REDIRECT_URL = "/login/"
WSGI_APPLICATION = "config.wsgi.application"
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "local.sqlite3",
    }
}
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 10},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
LIFTLOG_LOCAL_DEV_OPEN = os.environ.get("LIFTLOG_LOCAL_DEV_OPEN") == "1"
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["accounts.authentication.BearerTokenAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["accounts.permissions.AuthenticatedOrLocalDev"],
    "EXCEPTION_HANDLER": "accounts.exceptions.safe_exception_handler",
    "UNAUTHENTICATED_USER": None,
}
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"redact_secrets": {"()": "accounts.redact.RedactSecrets"}},
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "filters": ["redact_secrets"],
        }
    },
    "root": {"handlers": ["console"], "level": "INFO"},
}
ANALYTICS_STORE_REQUESTS = False
