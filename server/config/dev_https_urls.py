"""API-only surface for the isolated development listener."""
from django.http import JsonResponse
from django.urls import path
from config.urls import urlpatterns as shared_patterns

ALLOWED_PATHS = {
    'api/v1/auth/register','api/v1/auth/login','api/v1/auth/logout',
    'api/v1/account','api/v1/account/consent','api/v1/account/delete',
    'api/v1/sync/push','api/v1/sync/pull','api/v1/analytics/trends',
    'api/v1/chat/policy','api/v1/chat/consent','api/v1/chat/interpret','api/v1/chat/coach',
}
urlpatterns = [pattern for pattern in shared_patterns if str(pattern.pattern) in ALLOWED_PATHS]
urlpatterns += [path('healthz', lambda request: JsonResponse({'status': 'ok'}))]
