from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from accounts.service import resolve_bearer


class BearerTokenAuthentication(BaseAuthentication):
    def authenticate(self, request):
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header:
            return None
        scheme, _, raw_token = header.partition(" ")
        if scheme.lower() != "bearer" or not raw_token.strip():
            raise AuthenticationFailed("UNAUTHENTICATED")
        user = resolve_bearer(raw_token.strip())
        if user is None:
            raise AuthenticationFailed("UNAUTHENTICATED")
        return (user, raw_token.strip())
