"""Local cloud rehearsal against disposable PostgreSQL and Valkey, no external AI.

Run with server/.venv/bin/python from the root. Add PostgreSQL tools to PATH.
The test services are loopback-only and the database names are unique.
"""
import hashlib
import http.client
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path

import psycopg
from psycopg import sql

SERVER = Path(__file__).resolve().parents[1] / "server"
HOST = "pilot.liftlog.example"
PASSWORD = "Synthetic-Pilot-Only-59!"
BASIC_URL = "postgresql://liftlog:disposable@127.0.0.1:55487"
CACHE_URL = "redis://127.0.0.1:56387/0"
PORTS = (56181, 56182)


def run(*args, env=None, **kw):
    subprocess.run(args, cwd=SERVER, env=env, check=True, **kw)


def request(port, method, path, *, body=None, token=None, host=HOST, https=True):
    headers = {"Host": host, "Content-Type": "application/json"}
    if https:
        headers["X-Forwarded-Proto"] = "https"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if raw and response.getheader("Content-Type", "").startswith("application/json") else None
    finally:
        connection.close()


@contextmanager
def worker(port, env, folder):
    with (folder / f"worker-{port}.log").open("w+") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "gunicorn", "--bind", f"127.0.0.1:{port}",
             "--workers", "1", "--threads", "2", "config.wsgi:application"],
            cwd=SERVER, env=env, stdout=log, stderr=log,
        )
        try:
            for _ in range(80):
                if process.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                try:
                    if request(port, "GET", "/readyz") == (200, {"status": "ok"}):
                        break
                except OSError:
                    pass
                time.sleep(0.15)
            else:
                raise RuntimeError("Gunicorn never reported readiness")
            yield
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)


def seed(email, env):
    code = (
        "from unittest.mock import patch; from django.core.management import call_command; "
        f"with_password = patch('accounts.management.commands.create_pilot_account.getpass', return_value={PASSWORD!r}); "
        f"with_password.start(); call_command('create_pilot_account', {email!r}); with_password.stop()"
    )
    run(sys.executable, "manage.py", "shell", "-c", code, env=env, stdout=subprocess.DEVNULL)


def session(port, email, password=PASSWORD):
    return request(port, "POST", "/api/v1/auth/login", body={"email": email, "password": password})


def absence_check(url, deleted_id, survivor_id):
    with psycopg.connect(url) as db:
        deleted = db.execute("SELECT 1 FROM accounts_deletedaccount WHERE public_id=%s", (deleted_id,)).fetchone()
        records = db.execute(
            "SELECT p.public_id::text FROM records_workoutrecord w "
            "JOIN accounts_accountprofile p ON p.user_id=w.owner_id"
        ).fetchall()
        has_deleted_login = db.execute(
            "SELECT 1 FROM auth_user WHERE email = 'leave@synthetic.invalid'"
        ).fetchone()
        return bool(deleted) and records == [(survivor_id,)] and not has_deleted_login


def main():
    suffix = secrets.token_hex(6)
    names = [f"liftlog_rehearsal_{suffix}_{role}" for role in ("live", "before", "after")]
    urls = [f"{BASIC_URL}/{name}" for name in names]
    with psycopg.connect(f"{BASIC_URL}/liftlog_pilot_test", autocommit=True) as admin, ExitStack() as stack:
        for name in names:
            identifier = sql.Identifier(name)
            admin.execute(sql.SQL("CREATE DATABASE {}").format(identifier))
            stack.callback(admin.execute, sql.SQL("DROP DATABASE {} WITH (FORCE)").format(identifier))
        folder = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="liftlog-cloud-rehearsal-")))
        env = {
            **os.environ, "DJANGO_SETTINGS_MODULE": "config.cloud_settings",
            "DJANGO_ALLOWED_HOSTS": HOST, "DJANGO_SECRET_KEY": secrets.token_urlsafe(64),
            "LIFTLOG_ENV": "staging", "DJANGO_DEBUG": "1", "LIFTLOG_LOCAL_DEV_OPEN": "1",
            "DATABASE_URL": urls[0], "REDIS_URL": CACHE_URL, "CHAT_PROVIDER": "fake",
        }
        run(sys.executable, "manage.py", "migrate", "--noinput", env=env, stdout=subprocess.DEVNULL)
        run(sys.executable, "manage.py", "migrate", "--check", env=env)
        run(sys.executable, "manage.py", "makemigrations", "--check", "--dry-run", env=env)
        keep = "keep@synthetic.invalid"
        leave = "leave@synthetic.invalid"
        seed(keep, env)
        seed(leave, env)
        a, b = PORTS
        with worker(a, env, folder), worker(b, env, folder):
            assert request(a, "GET", "/readyz", https=False) == (200, {"status": "ok"})
            assert request(a, "GET", "/healthz", host="other.example")[0] == 400
            assert request(a, "GET", "/api/v1/account", https=False)[0] == 301
            assert request(a, "GET", "/api/v1/chat/policy")[0] == 401
            assert request(a, "POST", "/api/v1/chat/interpret", body={})[0] == 401
            assert request(a, "GET", "/login/")[0] == 404
            assert request(a, "POST", "/api/v1/auth/register", body={})[0] == 404
            print("PASS production-shaped routing, HTTPS enforcement, and forbidden dev bypass", flush=True)
            invalid_email = f"{suffix}@synthetic.invalid"
            for worker_port in (a, b, a, b, a):
                assert session(worker_port, invalid_email)[0] == 401
            assert session(b, invalid_email)[0] == 429
            print("PASS five failures shared across independent Gunicorn workers via Valkey", flush=True)

            accounts = []
            for email in (keep, leave):
                status, signed = session(a, email)
                assert status == 200
                token, account_id = signed["token"], signed["account"]["accountId"]
                accounts.append((token, account_id))
                assert request(b, "GET", "/api/v1/account", token=token)[1]["accountId"] == account_id
                assert request(b, "POST", "/api/v1/account/consent", token=token,
                               body={"cloudSync": "2026-11-05"})[0] == 200
                op = {"clientId": "same-workout", "baseRevision": 0, "kind": "upsert", "recordType": "workout",
                      "payload": {"date": "2026-11-05", "label": email.split("@")[0],
                                  "startedAt": "2026-11-05T15:00:00.000Z", "endedAt": "2026-11-05T16:00:00.000Z"}}
                digest = hashlib.sha256(json.dumps(op, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                push = {"accountId": account_id, "consent": {"cloudSync": "2026-11-05"}, "operations": [
                    {**op, "opId": "same-operation", "fingerprint": digest}
                ]}
                assert request(a, "POST", "/api/v1/sync/push", token=token, body=push)[0] == 200
                replay = request(b, "POST", "/api/v1/sync/push", token=token, body=push)
                assert replay[0] == 200 and replay[1]["results"][0]["replayed"]
            keep_token, keep_id = accounts[0]
            leave_token, leave_id = accounts[1]
            before = folder / "before.dump"
            after = folder / "after.dump"
            run("pg_dump", "-Fc", "-f", str(before), urls[0])
            assert request(b, "POST", "/api/v1/account/delete", token=leave_token,
                           body={"confirm": True, "password": PASSWORD}) == (200, {"deleted": True, "accountId": leave_id})
            assert request(a, "GET", "/api/v1/account", token=leave_token)[0] == 401
            run("pg_dump", "-Fc", "-f", str(after), urls[0])
        with worker(a, env, folder):
            status, page = request(a, "GET", "/api/v1/sync/pull", token=keep_token)
            assert status == 200 and page["accountId"] == keep_id
            assert [change["payload"]["label"] for change in page["changes"]] == ["keep"]
            assert request(a, "POST", "/api/v1/auth/logout", token=keep_token)[0] == 204
        with worker(b, env, folder):
            assert request(b, "GET", "/api/v1/account", token=keep_token)[0] == 401
        print("PASS accounts isolated, replay durable, survivor data and sessions persisted across restart", flush=True)
        for archive, url in zip((before, after), urls[1:], strict=True):
            run("pg_restore", "--exit-on-error", "--no-owner", "-d", url, str(archive))
        assert not absence_check(urls[1], leave_id, keep_id), "Pre-deletion restore must fail the cutover gate"
        assert absence_check(urls[2], leave_id, keep_id), "Post-deletion restore must retain deletion and survivor"
        print("PASS isolated restore rejected stale backup and verified post-deletion backup", flush=True)


if __name__ == "__main__":
    main()
