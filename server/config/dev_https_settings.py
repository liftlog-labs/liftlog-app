"""Isolated local HTTPS settings; deliberately does not load server/.env."""
import os
import tempfile
from pathlib import Path

from config.settings import *  # noqa: F403

_database = Path(os.environ['LIFTLOG_TEST_DATABASE'])
_root = Path(os.environ['LIFTLOG_HTTPS_RUN_DIR']).resolve()
if not _database.is_absolute() or _database.resolve().parent != _root or not (_root / 'disposable-https-run').is_file() or not _root.is_relative_to(Path(tempfile.gettempdir()).resolve()):
    raise ValueError('A marked disposable HTTPS database directory is required')
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': str(_database)}}
DEBUG = False
import ipaddress
import re
ALLOWED_HOSTS = os.environ['LIFTLOG_HTTPS_HOSTS'].split(',')
for host in ALLOWED_HOSTS:
    if host in ('127.0.0.1','localhost'):
        continue
    if re.fullmatch(r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+local',host):
        continue
    try:
        address=ipaddress.IPv4Address(host)
    except ValueError as error:
        raise ValueError('Exact local development hosts are required') from error
    if not any(address in ipaddress.ip_network(net) for net in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')):
        raise ValueError('Only private development addresses are permitted')
_port=int(os.environ.get('LIFTLOG_HTTPS_PORT','8443'))
if not 1<=_port<=65535:
    raise ValueError('Invalid HTTPS port')
os.environ['CHAT_PROVIDER']='fake'
CSRF_TRUSTED_ORIGINS = [f'https://{host}:{os.environ.get("LIFTLOG_HTTPS_PORT", "8443")}' for host in ALLOWED_HOSTS]
ROOT_URLCONF = 'config.dev_https_urls'
LIFTLOG_LOCAL_DEV_OPEN = False
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
X_FRAME_OPTIONS = 'DENY'
SECURE_HSTS_SECONDS = 0
SECURE_PROXY_SSL_HEADER = None
MIDDLEWARE = ['config.dev_https_middleware.ExactHostMiddleware', *MIDDLEWARE, 'django.middleware.clickjacking.XFrameOptionsMiddleware']
REST_FRAMEWORK = {**REST_FRAMEWORK, 'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated']}
