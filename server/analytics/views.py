from rest_framework.response import Response
from rest_framework.views import APIView

from analytics.calc import InvalidTrend, compute_trends


class TrendsView(APIView):
    def post(self, request):
        try:
            result = compute_trends(request.data)
        except (InvalidTrend, KeyError, TypeError, ValueError):
            return Response({"code": "INVALID_INPUT"}, status=400)
        return Response(result)
