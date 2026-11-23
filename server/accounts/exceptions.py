from rest_framework.exceptions import AuthenticationFailed, NotAuthenticated, PermissionDenied
from rest_framework.response import Response
from rest_framework.views import exception_handler


def safe_exception_handler(exc, context):
    if isinstance(exc, (AuthenticationFailed, NotAuthenticated)):
        return Response({"code": "UNAUTHENTICATED"}, status=401)
    if isinstance(exc, PermissionDenied):
        return Response({"code": "FORBIDDEN"}, status=403)
    response = exception_handler(exc, context)
    if response is None or response.status_code >= 500:
        return Response({"code": "ERROR"}, status=500)
    if response.status_code == 401:
        return Response({"code": "UNAUTHENTICATED"}, status=401)
    if response.status_code == 403:
        return Response({"code": "FORBIDDEN"}, status=403)
    if response.status_code == 400:
        return Response({"code": "INVALID_INPUT"}, status=400)
    return response
