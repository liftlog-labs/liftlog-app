from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.service import AccountError, account_payload, delete_account, login, logout, register, update_profile


def _client_ip(request) -> str:
    return request.META.get("REMOTE_ADDR", "") or "unknown"


def _call(action):
    try:
        return action()
    except AccountError as error:
        body = {"code": error.code, **error.extra}
        return Response(body, status=error.status)


class RegisterView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        return _call(lambda: Response(register(request.data, _client_ip(request)), status=201))


class LoginView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        return _call(lambda: Response(login(request.data, _client_ip(request))))


class LogoutView(APIView):
    def post(self, request):
        def action():
            logout(request.user, request.auth)
            return Response(status=204)

        return _call(action)


class DeleteAccountView(APIView):
    def post(self, request):
        return _call(lambda: Response(delete_account(request.user, request.data, _client_ip(request))))


class AccountView(APIView):
    def get(self, request):
        return Response(account_payload(request.user.account_profile))

    def patch(self, request):
        return _call(lambda: Response(update_profile(request.user, request.data)))
