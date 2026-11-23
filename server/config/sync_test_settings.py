"""Opt-in settings for disposable local HTTP sync integration runs.

Set LIFTLOG_TEST_DATABASE to an absolute path in a temporary directory before
running migrations or runserver with --settings=config.sync_test_settings.
"""
from config.settings import *  # noqa: F403

import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

_test_database = os.environ.get("LIFTLOG_TEST_DATABASE")
if not _test_database:
    raise ImproperlyConfigured("LIFTLOG_TEST_DATABASE is required for disposable sync runs")
_test_path = Path(_test_database).expanduser()
if not _test_path.is_absolute() or _test_path.resolve() == (BASE_DIR / "local.sqlite3").resolve():  # noqa: F405
    raise ImproperlyConfigured("LIFTLOG_TEST_DATABASE must be an absolute disposable database path")
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": str(_test_path)}}
ALLOWED_HOSTS = ["127.0.0.1", "localhost", "10.0.2.2", "testserver"]
LIFTLOG_LOCAL_DEV_OPEN = False
