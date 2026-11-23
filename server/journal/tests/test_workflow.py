import pytest
from django.contrib.auth.models import User
from django.test import Client


@pytest.mark.django_db
def test_workout_form_persists_and_is_private():
    from journal.models import Workout, WorkoutSet
    user = User.objects.create_user(username="lifter", password="course-password")
    other = User.objects.create_user(username="other", password="course-password")
    client = Client()
    assert client.get("/").status_code == 302
    client.force_login(user)
    response = client.post("/", {"label": "Leg day", "date": "2026-11-08"})
    workout = Workout.objects.get(owner=user)
    assert response.status_code == 302
    url = f"/workouts/{workout.pk}/"
    assert client.post(url, {"exercise": "Leg press", "load_lb": "100", "reps": "10"}).status_code == 302
    assert WorkoutSet.objects.get(workout=workout).reps == 10
    assert b"Leg press" in client.get(url).content
    invalid = client.post(url, {"exercise": "Leg press", "load_lb": "-1", "reps": "0"})
    assert invalid.status_code == 200
    assert WorkoutSet.objects.count() == 1
    client.force_login(other)
    assert client.get(url).status_code == 404
    assert b"Leg day" not in client.get("/").content


@pytest.mark.django_db
def test_csrf_and_login_pages():
    client = Client(enforce_csrf_checks=True)
    assert client.get("/login/").status_code == 200
    assert client.get("/register/").status_code == 200
    assert client.post("/register/", {}).status_code == 403

@pytest.mark.django_db
@pytest.mark.parametrize('attempt_name', ['guard@synthetic.invalid', 'ｇｕａｒｄ@synthetic.invalid'])
def test_browser_login_shares_api_failed_login_limits(attempt_name):
    from django.core.cache import cache
    from rest_framework.test import APIClient
    cache.clear()
    user = User.objects.create_user(username='guard@synthetic.invalid', email='guard@synthetic.invalid', password='Synthetic-password-498!')
    browser = Client()
    for _ in range(5):
        assert browser.post('/login/', {'username': attempt_name, 'password': 'wrong'}).status_code == 200
    assert browser.post('/login/', {'username': user.username, 'password': 'Synthetic-password-498!'}).status_code == 429
    assert APIClient().post('/api/v1/auth/login', {'email': user.email, 'password': 'Synthetic-password-498!'}, format='json').status_code == 429
    cache.clear()


@pytest.mark.django_db
def test_registration_attempt_budget_is_shared_by_web_and_api():
    from django.core.cache import cache
    from rest_framework.test import APIClient
    cache.clear()
    for _ in range(10):
        assert Client().post('/register/', {}).status_code == 200
        assert APIClient().post('/api/v1/auth/register', {}, format='json').status_code == 400
    assert Client().post('/register/', {}).status_code == 429
    assert APIClient().post('/api/v1/auth/register', {}, format='json').status_code == 429
    cache.clear()
