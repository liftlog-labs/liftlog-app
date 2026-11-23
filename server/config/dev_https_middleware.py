"""Enforce ALLOWED_HOSTS even on API handlers that never construct a URL."""
class ExactHostMiddleware:
    def __init__(self, get_response):
        self.get_response=get_response
    def __call__(self, request):
        request.get_host()
        return self.get_response(request)
