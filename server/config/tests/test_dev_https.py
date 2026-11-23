import importlib
from pathlib import Path

import pytest
from django.test import Client, override_settings


def configuration(monkeypatch, tmp_path, hosts='localhost,127.0.0.1,liftlog-dev.local,192.168.0.100'):
    (tmp_path/'disposable-https-run').touch()
    for key,value in {'LIFTLOG_TEST_DATABASE':str(tmp_path/'synthetic.sqlite3'),'LIFTLOG_HTTPS_RUN_DIR':str(tmp_path),'LIFTLOG_HTTPS_HOSTS':hosts,'LIFTLOG_HTTPS_PORT':'8443','CHAT_PROVIDER':'fake'}.items():
        monkeypatch.setenv(key,value)
    from config import dev_https_settings
    return importlib.reload(dev_https_settings)


def test_dev_configuration_is_exact_disposable_and_protected(monkeypatch,tmp_path):
    config=configuration(monkeypatch,tmp_path)
    assert not config.DEBUG and not config.LIFTLOG_LOCAL_DEV_OPEN
    assert config.ALLOWED_HOSTS==['localhost','127.0.0.1','liftlog-dev.local','192.168.0.100']
    assert config.CSRF_TRUSTED_ORIGINS==[f'https://host:8443'.replace('host',host) for host in config.ALLOWED_HOSTS]
    assert config.SESSION_COOKIE_SECURE and config.CSRF_COOKIE_SECURE
    assert config.DATABASES['default']['NAME']==str(tmp_path/'synthetic.sqlite3')
    assert config.REST_FRAMEWORK['DEFAULT_PERMISSION_CLASSES']==['rest_framework.permissions.IsAuthenticated']
    with override_settings(ROOT_URLCONF=config.ROOT_URLCONF,ALLOWED_HOSTS=config.ALLOWED_HOSTS,MIDDLEWARE=config.MIDDLEWARE,DEBUG=False):
        client=Client()
        assert client.get('/healthz',HTTP_HOST='localhost',secure=True).status_code==200
        for path in ('/','/login/','/register/','/admin/','/workouts/1/'):
            assert client.get(path,HTTP_HOST='localhost',secure=True).status_code==404
        assert client.get('/api/v1/chat/policy',HTTP_HOST='localhost',secure=True).status_code==401
        assert client.get('/healthz',HTTP_HOST='untrusted.invalid',secure=True).status_code==400


@pytest.mark.parametrize('hosts',['*','example.com','0.0.0.0','8.8.8.8','foo..local'])
def test_dev_hosts_reject_wildcards_and_public_destinations(monkeypatch,tmp_path,hosts):
    with pytest.raises(ValueError): configuration(monkeypatch,tmp_path,hosts)


def test_dev_database_rejects_personal_or_unmarked_location(monkeypatch,tmp_path):
    configuration(monkeypatch,tmp_path)
    monkeypatch.setenv('LIFTLOG_TEST_DATABASE',str(Path(__file__).resolve().parents[2]/'local.sqlite3'))
    from config import dev_https_settings
    with pytest.raises(ValueError):importlib.reload(dev_https_settings)


def test_https_settings_skip_local_credential_file(monkeypatch):
    from config.env import load_local_env
    monkeypatch.setenv('DJANGO_SETTINGS_MODULE','config.dev_https_settings')
    def forbidden(*args,**kwargs):raise AssertionError('Must not read local env')
    monkeypatch.setattr(Path,'read_text',forbidden)
    load_local_env()


def test_expiry_helper_only_changes_marked_disposable_database(monkeypatch,tmp_path):
    import importlib.util
    import json
    import sqlite3
    import sys
    source=Path(__file__).resolve().parents[3]/'scripts/dev-https.py'
    spec=importlib.util.spec_from_file_location('dev_https_cli_test',source)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    cert_dir=tmp_path/'certificates';cert_dir.mkdir()
    run=tmp_path/'run';run.mkdir();(run/'disposable-https-run').touch()
    database=run/'synthetic.sqlite3'
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE accounts_authsession(expires_at TEXT)')
        db.execute("INSERT INTO accounts_authsession VALUES ('2099-01-01')")
    metadata=cert_dir/'active-run.json'
    metadata.write_text(json.dumps({'pid':999999,'runDir':str(run),'database':str(database)}))
    monkeypatch.setattr(module,'CA_DIR',cert_dir)
    monkeypatch.setattr(sys,'argv',['dev-https.py','expire-sessions'])
    module.main()
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT expires_at FROM accounts_authsession').fetchone()[0].startswith('2000-01-01')
    metadata.write_text(json.dumps({'pid':999999,'runDir':str(run),'database':str(tmp_path/'personal.sqlite3')}))
    with pytest.raises(SystemExit): module.main()
    assert not (tmp_path/'personal.sqlite3').exists()
