from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from records.service import SyncError, grant_cloud_consent, pull_changes, push_batch


def _call(action):
    try:
        return action()
    except SyncError as error:
        return Response({"code": error.code, **error.extra}, status=error.status)


class ConsentView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        return _call(lambda: Response(grant_cloud_consent(request.user, request.data)))


class PushView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        return _call(lambda: Response(push_batch(request.user, request.data)))


class PullView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        def action():
            try:
                cursor = int(request.query_params.get("cursor", "0"))
                limit = int(request.query_params.get("limit", "100"))
            except (TypeError, ValueError):
                raise SyncError("INVALID_INPUT", 400) from None
            return Response(pull_changes(request.user, cursor, limit))

        return _call(action)
