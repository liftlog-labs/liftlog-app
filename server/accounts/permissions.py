from django.conf import settings
from rest_framework.exceptions import NotAuthenticated
from rest_framework.permissions import BasePermission


class AuthenticatedOrLocalDev(BasePermission):
    def has_permission(self, request, view):
        if request.user and request.user.is_authenticated:
            return True
        if settings.DEBUG and settings.LIFTLOG_LOCAL_DEV_OPEN:
            return True
        raise NotAuthenticated()
