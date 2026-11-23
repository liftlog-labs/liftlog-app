import hashlib
import logging
import secrets
from datetime import timedelta

from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.models import User
from django.contrib.auth.password_validation import validate_password
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.utils import timezone

from accounts.models import AccountProfile, AuthSession

logger = logging.getLogger(__name__)

SESSION_TTL = timedelta(days=30)
FAILURE_WINDOW_SECONDS = 15 * 60
EMAIL_FAILURE_LIMIT = 5
IP_FAILURE_LIMIT = 20
MAX_EMAIL_LENGTH = 150
MAX_PASSWORD_LENGTH = 128
_DUMMY_HASH = None


class AccountError(Exception):
    def __init__(self, code: str, status: int, extra: dict | None = None):
        self.code = code
        self.status = status
        self.extra = extra or {}


def account_payload(profile: AccountProfile) -> dict:
    from records.service import cloud_consent_version

    return {
        "accountId": str(profile.public_id),
        "email": profile.user.email,
        "displayName": profile.display_name,
        "revision": profile.revision,
        "cloudSyncConsent": cloud_consent_version(profile.user),
    }


def register(data, ip: str) -> dict:
    from records.models import CloudConsent
    from records.service import CLOUD_SYNC_VERSION

    _require_mapping(data, {"email", "password", "displayName", "cloudSyncConsent"})
    if "cloudSyncConsent" in data and data["cloudSyncConsent"] != CLOUD_SYNC_VERSION:
        raise AccountError("INVALID_INPUT", 400)
    email = _normalize_email(data.get("email"))
    password = _require_password(data.get("password"))
    display_name = _clean_display_name(data.get("displayName", ""))
    user = User(username=email, email=email)
    try:
        validate_password(password, user=user)
    except ValidationError as error:
        raise AccountError("INVALID_PASSWORD", 400, {"reasons": list(error.messages)}) from error
    try:
        with transaction.atomic():
            user = User.objects.create_user(username=email, email=email, password=password)
            profile = AccountProfile.objects.create(user=user, display_name=display_name)
            if "cloudSyncConsent" in data:
                CloudConsent.objects.create(owner=user, version=CLOUD_SYNC_VERSION)
    except IntegrityError as error:
        raise AccountError("EMAIL_IN_USE", 400) from error
    logger.info("register_succeeded")
    return _session_body(user, profile)


def login(data, ip: str) -> dict:
    _require_mapping(data, {"email", "password"})
    email = _normalize_email(data.get("email"))
    password = _require_password(data.get("password"))
    if _locked(email, ip):
        logger.info("login_rate_limited")
        raise AccountError("RATE_LIMITED", 429)
    user = User.objects.filter(username=email, is_active=True).first()
    if user is None:
        check_password(password, _dummy_hash())
        matched = False
    else:
        matched = user.check_password(password)
    if not matched:
        _record_failure(email, ip)
        logger.info("login_failed")
        raise AccountError("INVALID_CREDENTIALS", 401)
    cache.delete(_email_key(email))
    logger.info("login_succeeded")
    return _session_body(user, user.account_profile)


def delete_account(user, data, ip: str) -> dict:
    _require_mapping(data, {"confirm", "password"})
    if data.get("confirm") is not True:
        raise AccountError("INVALID_INPUT", 400)
    password = _require_password(data.get("password"))
    if _locked(user.email, ip):
        logger.info("account_delete_rate_limited")
        raise AccountError("RATE_LIMITED", 429)
    if not user.check_password(password):
        _record_failure(user.email, ip)
        logger.info("account_delete_rejected")
        raise AccountError("INVALID_CREDENTIALS", 401)
    cache.delete(_email_key(user.email))
    from records.service import SyncError, erase_account

    try:
        with transaction.atomic():
            public_id = erase_account(user)
    except SyncError as error:
        raise AccountError(error.code, error.status) from None
    logger.info("account_deleted")
    return {"deleted": True, "accountId": public_id}


def logout(user, raw_token: str) -> None:
    updated = AuthSession.objects.filter(
        user=user,
        token_hash=_hash_token(raw_token),
        revoked_at__isnull=True,
        expires_at__gt=timezone.now(),
    ).update(revoked_at=timezone.now())
    if updated != 1:
        raise AccountError("UNAUTHENTICATED", 401)
    logger.info("logout_succeeded")


def update_profile(user, data) -> dict:
    _require_mapping(data, {"displayName", "baseRevision"})
    display_name = _clean_display_name(data.get("displayName"))
    base_revision = data.get("baseRevision")
    if type(base_revision) is not int or base_revision < 1:
        raise AccountError("INVALID_INPUT", 400)
    with transaction.atomic():
        profile = AccountProfile.objects.select_for_update().get(user=user)
        if profile.revision != base_revision:
            conflict = {
                "server": account_payload(profile),
                "rejected": {"displayName": display_name},
            }
        else:
            conflict = None
            profile.display_name = display_name
            profile.revision += 1
            profile.save(update_fields=["display_name", "revision", "updated_at"])
        payload = account_payload(profile)
    if conflict is not None:
        raise AccountError("CONFLICT", 409, conflict)
    return payload


def resolve_bearer(raw_token: str):
    if not isinstance(raw_token, str) or not raw_token or len(raw_token) > MAX_PASSWORD_LENGTH:
        return None
    session = (
        AuthSession.objects.select_related("user")
        .filter(token_hash=_hash_token(raw_token), revoked_at__isnull=True, expires_at__gt=timezone.now())
        .first()
    )
    if session is None or not session.user.is_active:
        return None
    return session.user


def _session_body(user, profile: AccountProfile) -> dict:
    raw_token, expires_at = _issue(user)
    return {
        "token": raw_token,
        "expiresAt": expires_at.isoformat(),
        "account": account_payload(profile),
    }


def _issue(user) -> tuple[str, object]:
    raw_token = secrets.token_urlsafe(32)
    expires_at = timezone.now() + SESSION_TTL
    AuthSession.objects.create(user=user, token_hash=_hash_token(raw_token), expires_at=expires_at)
    return raw_token, expires_at


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _dummy_hash() -> str:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = make_password("dummy-password-not-a-secret")
    return _DUMMY_HASH


def _require_mapping(data, allowed: set[str]) -> None:
    if not isinstance(data, dict) or set(data) - allowed:
        raise AccountError("INVALID_INPUT", 400)


def _normalize_email(value) -> str:
    if not isinstance(value, str):
        raise AccountError("INVALID_INPUT", 400)
    email = value.strip().lower()
    if not email or len(email) > MAX_EMAIL_LENGTH:
        raise AccountError("INVALID_INPUT", 400)
    try:
        validate_email(email)
    except ValidationError as error:
        raise AccountError("INVALID_INPUT", 400) from error
    return email


def _require_password(value) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_PASSWORD_LENGTH:
        raise AccountError("INVALID_INPUT", 400)
    return value


def _clean_display_name(value) -> str:
    if not isinstance(value, str):
        raise AccountError("INVALID_INPUT", 400)
    name = value.strip()
    if len(name) > 80 or any(ord(character) < 32 for character in name):
        raise AccountError("INVALID_INPUT", 400)
    return name


def _email_key(email: str) -> str:
    return f"login-fail-email:{email}"


def _ip_key(ip: str) -> str:
    return f"login-fail-ip:{ip or 'unknown'}"


def _locked(email: str, ip: str) -> bool:
    return cache.get(_email_key(email), 0) >= EMAIL_FAILURE_LIMIT or cache.get(_ip_key(ip), 0) >= IP_FAILURE_LIMIT


def _record_failure(email: str, ip: str) -> None:
    _bump(_email_key(email))
    _bump(_ip_key(ip))


def _bump(key: str) -> None:
    if cache.add(key, 1, timeout=FAILURE_WINDOW_SECONDS):
        return
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, timeout=FAILURE_WINDOW_SECONDS)
