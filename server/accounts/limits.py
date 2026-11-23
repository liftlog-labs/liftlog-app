"""Shared local guards. Production still needs a shared atomic cache/edge budget."""
from django.core.cache import cache
from django.http import HttpResponse, JsonResponse

from accounts.service import _bump


class RegistrationAttemptLimit:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.method == 'POST' and request.path in {'/register/', '/api/v1/auth/register'}:
            # Count attempts before validation/password hashing, across both surfaces.
            key = f"registration-attempt-ip:{request.META.get('REMOTE_ADDR') or 'unknown'}"
            _bump(key)
            if cache.get(key, 0) > 20:
                if request.path.startswith('/api/'):
                    return JsonResponse({'code': 'RATE_LIMITED'}, status=429)
                return HttpResponse('Too many attempts. Try again later.', status=429)
        return self.get_response(request)
