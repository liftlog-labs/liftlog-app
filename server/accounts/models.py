import uuid

from django.conf import settings
from django.db import models


class AccountProfile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="account_profile")
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    display_name = models.CharField(max_length=80, blank=True)
    revision = models.PositiveIntegerField(default=1)
    updated_at = models.DateTimeField(auto_now=True)


class AuthSession(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="auth_sessions")
    token_hash = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)


class DeletedAccount(models.Model):
    public_id = models.UUIDField(unique=True)
    email = models.EmailField()
    deleted_at = models.DateTimeField(auto_now_add=True)


class AIConsent(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="ai_consents")
    provider_id = models.CharField(max_length=128)
    consent_version = models.CharField(max_length=40)
    accepted = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "provider_id"], name="one_ai_consent_per_provider")]


class CoachingRateBucket(models.Model):
    """Fixed-window budgets shared by every worker using the application DB."""
    key = models.CharField(max_length=120, primary_key=True)
    count = models.PositiveIntegerField(default=0)


class LoginAttemptBucket(models.Model):
    """Short-lived, shared password verification budget."""
    key = models.CharField(max_length=100, primary_key=True)
    window_id = models.BigIntegerField(db_index=True)
    count = models.PositiveIntegerField()
