from functools import lru_cache

from django.conf import settings
from django.core.cache import cache
from django.http import JsonResponse
from django.urls import path
from django.views.decorators.http import require_safe
from redis.exceptions import RedisError
from django.db.utils import DatabaseError

from accounts.models import AuthSession, LoginAttemptBucket
from chat.coaching_context import CoachingContextError, run_context
from config.dev_https_urls import ALLOWED_PATHS
from config.urls import urlpatterns as shared_patterns


@require_safe
def health(request):
    return JsonResponse({"status": "ok"})


@lru_cache(maxsize=1)
def check_bridge():
    run_context({
        "asOf": "2026-01-01T00:00:00Z", "timeZone": "UTC",
        "profile": {
            "goal": None, "experience": None, "trainingDays": None, "sessionMinutes": None,
            "equipment": None, "preferences": None, "updatedAt": None, "revision": 0,
        },
        "performedSets": [], "plannedSets": [], "activeWorkout": None,
    })


@require_safe
def ready(request):
    try:
        AuthSession.objects.exists()
        if settings.LIFTLOG_POSTGRES_LOGIN_LIMIT:
            LoginAttemptBucket.objects.exists()
        else:
            cache.get("readiness")
        check_bridge()
    except (DatabaseError, RedisError, CoachingContextError):
        return JsonResponse({"status": "unavailable"}, status=503)
    return JsonResponse({"status": "ok"})


urlpatterns = [
    pattern for pattern in shared_patterns
    if str(pattern.pattern) in ALLOWED_PATHS - {"api/v1/auth/register"}
] + [path("healthz", health), path("readyz", ready)]
