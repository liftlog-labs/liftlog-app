from urllib.parse import unquote, urlsplit

from django.core.exceptions import ImproperlyConfigured


def postgres_database(raw, *, sslmode):
    url = urlsplit(raw)
    if (url.scheme not in {"postgresql", "postgres"} or not url.hostname
            or not url.username or not url.password or not url.path.lstrip("/")
            or url.query or url.fragment):
        raise ImproperlyConfigured("Set a PostgreSQL URL with credentials and a database name.")
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(url.path[1:]),
        "USER": unquote(url.username),
        "PASSWORD": unquote(url.password),
        "HOST": url.hostname,
        "PORT": url.port or 5432,
        "OPTIONS": {"sslmode": sslmode, "connect_timeout": 3},
    }
