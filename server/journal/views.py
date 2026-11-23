import unicodedata
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.views import LoginView
from django.core.cache import cache
from django.http import HttpResponse
from accounts.service import _email_key, _locked, _record_failure
from django.shortcuts import get_object_or_404, redirect, render
from journal.forms import SetForm, WorkoutForm
from journal.models import Workout


def register(request):
    form = UserCreationForm(request.POST if request.method == "POST" else None)
    if request.method == "POST" and form.is_valid():
        login(request, form.save())
        return redirect("journal-home")
    return render(request, "journal/form.html", {"form": form, "title": "Create account"})


@login_required
def home(request):
    form = WorkoutForm(request.POST if request.method == "POST" else None)
    if request.method == "POST" and form.is_valid():
        workout = form.save(commit=False)
        workout.owner = request.user
        workout.save()
        return redirect("journal-detail", pk=workout.pk)
    return render(request, "journal/home.html", {"form": form, "workouts": Workout.objects.filter(owner=request.user)})


@login_required
def detail(request, pk):
    workout = get_object_or_404(Workout, pk=pk, owner=request.user)
    form = SetForm(request.POST if request.method == "POST" else None)
    if request.method == "POST" and form.is_valid():
        entry = form.save(commit=False)
        entry.workout = workout
        entry.save()
        return redirect("journal-detail", pk=workout.pk)
    return render(request, "journal/detail.html", {"form": form, "workout": workout})


class LimitedLoginView(LoginView):
    template_name = "journal/form.html"

    def post(self, request, *args, **kwargs):
        self.attempt_name = unicodedata.normalize("NFKC", request.POST.get("username", "")).strip().lower()
        self.attempt_ip = request.META.get("REMOTE_ADDR", "")
        if _locked(self.attempt_name, self.attempt_ip):
            return HttpResponse("Too many attempts. Try again later.", status=429)
        if len(request.POST.get("password", "")) > 128 or len(self.attempt_name) > 150:
            _record_failure(self.attempt_name, self.attempt_ip)
            return HttpResponse("Invalid credentials.", status=400)
        return super().post(request, *args, **kwargs)

    def form_invalid(self, form):
        _record_failure(self.attempt_name, self.attempt_ip)
        return super().form_invalid(form)

    def form_valid(self, form):
        cache.delete(_email_key(self.attempt_name))
        return super().form_valid(form)
