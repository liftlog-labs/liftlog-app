from django.urls import path
from django.contrib.auth import views as auth_views
from journal import views as journal_views

from accounts.views import AccountView, DeleteAccountView, LoginView, LogoutView, RegisterView
from analytics.views import TrendsView
from chat.views import AIConsentView, InterpretView, PolicyView
from chat.coaching_views import CoachingView
from records.views import ConsentView, PullView, PushView

urlpatterns = [
    path("", journal_views.home, name="journal-home"),
    path("workouts/<int:pk>/", journal_views.detail, name="journal-detail"),
    path("register/", journal_views.register, name="web-register"),
    path("login/", journal_views.LimitedLoginView.as_view(), name="web-login"),
    path("logout/", auth_views.LogoutView.as_view(), name="web-logout"),
    path("api/v1/auth/register", RegisterView.as_view()),
    path("api/v1/auth/login", LoginView.as_view()),
    path("api/v1/auth/logout", LogoutView.as_view()),
    path("api/v1/account", AccountView.as_view()),
    path("api/v1/account/consent", ConsentView.as_view()),
    path("api/v1/account/delete", DeleteAccountView.as_view()),
    path("api/v1/sync/push", PushView.as_view()),
    path("api/v1/sync/pull", PullView.as_view()),
    path("api/v1/analytics/trends", TrendsView.as_view()),
    path("api/v1/chat/policy", PolicyView.as_view()),
    path("api/v1/chat/consent", AIConsentView.as_view()),
    path("api/v1/chat/interpret", InterpretView.as_view()),
    path("api/v1/chat/coach", CoachingView.as_view()),
]
