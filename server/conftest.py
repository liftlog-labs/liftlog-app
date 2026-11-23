import pytest
from rest_framework.test import APIClient

PASSWORD = "Liftlog-Test-Pass-1"


@pytest.fixture
def auth_client(db):
    client = APIClient()
    created = client.post(
        "/api/v1/auth/register",
        {"email": "trend@example.com", "password": PASSWORD, "displayName": "Trend"},
        format="json",
    )
    assert created.status_code == 201
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {created.json()['token']}")
    return client


@pytest.fixture(autouse=True)
def isolated_attempt_counters():
    # Like the disposable database, process cache state must not cross test cases.
    from django.core.cache import cache
    cache.clear()
    yield
    cache.clear()
