"""Use only with a disposable, local PostgreSQL cluster."""
import os

from django.core.exceptions import ImproperlyConfigured

from config.postgres import postgres_database
from config.settings import *  # noqa: F403

_database = postgres_database(os.environ["LIFTLOG_TEST_POSTGRES_URL"], sslmode="disable")
if _database["HOST"] != "127.0.0.1" or _database["NAME"] != "liftlog_pilot_test":
    raise ImproperlyConfigured("Use the disposable local liftlog_pilot_test database.")
DATABASES = {"default": _database}
LIFTLOG_LOCAL_DEV_OPEN = False
ALLOWED_HOSTS = ["127.0.0.1", "localhost", "testserver"]
