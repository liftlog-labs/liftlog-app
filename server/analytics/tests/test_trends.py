from datetime import date

import pytest

from analytics.calc import InvalidTrend, compute_trends


BENCH = "22222222-2222-4222-8222-222222222222"


def workout(day: str, sets: list[tuple[str, int | None]], assisted: bool = False) -> dict:
    return {
        "id": f"workout-{day}",
        "date": day,
        "exercises": [
            {
                "exerciseId": BENCH,
                "name": "Barbell Bench Press",
                "type": "barbell",
                "sets": [
                    {"loadLb": load, "reps": reps, "assisted": assisted, "durationSec": None}
                    for load, reps in sets
                ],
            }
        ],
    }


def test_two_week_bench_trend():
    result = compute_trends(
        {
            "range": {"start": "2026-10-01", "end": "2026-10-14"},
            "workouts": [
                workout("2026-10-01", [("100", 5), ("100", 5)]),
                workout("2026-10-08", [("100", 5)]),
            ],
        }
    )
    bench = result["exercises"][0]
    assert result["workoutCount"] == 2
    assert bench["totalVolumeLb"] == "1500.0"
    assert bench["averageVolumeLb"] == "750.0"
    assert bench["sessionCount"] == 2
    assert bench["frequencyPerWeek"] == "1.00"
    assert date.fromisoformat(result["range"]["start"])


def test_empty_history():
    result = compute_trends({"range": {"start": "2026-10-01", "end": "2026-10-14"}, "workouts": []})
    assert result["exercises"] == []
    assert result["workoutCount"] == 0


def test_assisted_and_incomplete_sets():
    assisted = compute_trends(
        {"range": {"start": "2026-10-01", "end": "2026-10-07"}, "workouts": [workout("2026-10-01", [("100", 5)], True)]}
    )
    assert assisted["exercises"][0]["totalVolumeLb"] == "500.0"
    incomplete = compute_trends(
        {
            "range": {"start": "2026-10-01", "end": "2026-10-07"},
            "workouts": [workout("2026-10-01", [("100", None), ("100", 5)])],
        }
    )
    assert incomplete["exercises"][0]["totalVolumeLb"] == "500.0"


def test_end_before_start_is_invalid():
    with pytest.raises(InvalidTrend):
        compute_trends({"range": {"start": "2026-10-14", "end": "2026-10-01"}, "workouts": []})


@pytest.mark.django_db
def test_trends_endpoint_returns_fixture(auth_client):
    client = auth_client
    response = client.post(
        "/api/v1/analytics/trends",
        {
            "range": {"start": "2026-10-01", "end": "2026-10-14"},
            "workouts": [
                workout("2026-10-01", [("100", 5), ("100", 5)]),
                workout("2026-10-08", [("100", 5)]),
            ],
        },
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["exercises"][0]["frequencyPerWeek"] == "1.00"


@pytest.mark.django_db
def test_trends_endpoint_rejects_a_bad_range(auth_client):
    client = auth_client
    response = client.post(
        "/api/v1/analytics/trends",
        {"range": {"start": "2026-10-14", "end": "2026-10-01"}, "workouts": []},
        format="json",
    )
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_INPUT"


@pytest.mark.parametrize('malformation', ['root', 'workout', 'exercise', 'set', 'nan', 'infinity', 'huge-exponent', 'long-number', 'reps-object', 'positive-exponent', 'negative-exponent'])
@pytest.mark.django_db
def test_trends_rejects_malformed_nested_and_numeric_input(auth_client, malformation):
    payload = {'range': {'start': '2026-10-01', 'end': '2026-10-14'}, 'workouts': [workout('2026-10-01', [('100', 5)])]}
    exercise = payload['workouts'][0]['exercises'][0]
    if malformation == 'root':
        payload = []
    elif malformation == 'workout':
        payload['workouts'] = [None]
    elif malformation == 'exercise':
        payload['workouts'][0]['exercises'] = [None]
    elif malformation == 'set':
        exercise['sets'] = [None]
    elif malformation == 'reps-object':
        exercise['sets'][0]['reps'] = {}
    else:
        exercise['sets'][0]['loadLb'] = {'nan': 'NaN', 'infinity': 'Infinity', 'huge-exponent': '1e9999999999999999999', 'long-number': '9' * 10000, 'positive-exponent': '1e1000000', 'negative-exponent': '1e-1000000'}[malformation]
    response = auth_client.post('/api/v1/analytics/trends', payload, format='json')
    assert response.status_code == 400
    assert response.json() == {'code': 'INVALID_INPUT'}
