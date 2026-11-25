"""Reserve password checks atomically before doing the expensive work."""
from django.db import connection, transaction
from django.db.utils import NotSupportedError
from django.utils.crypto import salted_hmac


RESERVE = """
INSERT INTO accounts_loginattemptbucket AS bucket (key, window_id, count)
VALUES (%s, %s, 1)
ON CONFLICT (key) DO UPDATE SET count = bucket.count + 1
WHERE bucket.count < %s
RETURNING count
"""


class Exhausted(Exception):
    pass


def _database_window(cursor, seconds):
    cursor.execute("SELECT FLOOR(EXTRACT(EPOCH FROM statement_timestamp()) / %s)::bigint", [seconds])
    return cursor.fetchone()[0]


def reserve_login_attempt(email, *, window_seconds, identity_limit, shared_limit):
    if connection.vendor != "postgresql":
        raise NotSupportedError("Shared login limits require PostgreSQL.")

    try:
        with transaction.atomic(), connection.cursor() as cursor:
            window = _database_window(cursor, window_seconds)
            digest = salted_hmac("liftlog.login-attempt", f"{window}:{email}", algorithm="sha256").hexdigest()
            # The shared limit applies regardless of forwarded IP headers.
            cursor.execute(RESERVE, [f"{window}:shared", window, shared_limit])
            shared = cursor.fetchone()
            if shared is None:
                raise Exhausted
            cursor.execute(RESERVE, [f"{window}:{digest}", window, identity_limit])
            if cursor.fetchone() is None:
                raise Exhausted
            if shared[0] == 1:
                cursor.execute("""
                    DELETE FROM accounts_loginattemptbucket WHERE key IN (
                        SELECT key FROM accounts_loginattemptbucket
                        WHERE window_id < %s ORDER BY window_id LIMIT 100
                    )
                """, [window - 1])
    except Exhausted:
        return False
    return True
