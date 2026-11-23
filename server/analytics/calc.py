from datetime import date
from decimal import Decimal, DecimalException, ROUND_HALF_UP


class InvalidTrend(Exception):
    pass


def _number(value) -> Decimal:
    # Bound conversion work and exponent expansion before doing arithmetic.
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise InvalidTrend("number")
    text = str(value)
    if len(text) > 128:
        raise InvalidTrend("number")
    number = Decimal(text)
    if not number.is_finite() or abs(number.as_tuple().exponent) > 128 or number.adjusted() > 24:
        raise InvalidTrend("number")
    return number


def compute_trends(payload: dict) -> dict:
    try:
        return _compute_trends(payload)
    except (KeyError, TypeError, ValueError, DecimalException) as error:
        raise InvalidTrend("payload") from error


def _compute_trends(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise InvalidTrend("payload")
    try:
        start = date.fromisoformat(payload["range"]["start"])
        end = date.fromisoformat(payload["range"]["end"])
    except (KeyError, TypeError, ValueError) as error:
        raise InvalidTrend("range") from error
    days = (end - start).days + 1
    if days < 1:
        raise InvalidTrend("range")
    workouts = payload.get("workouts")
    if not isinstance(workouts, list):
        raise InvalidTrend("workouts")

    grouped: dict[str, dict] = {}
    workout_ids: set[str] = set()
    for workout in workouts:
        if not isinstance(workout, dict) or not isinstance(workout.get("exercises", []), list):
            raise InvalidTrend("workout")
        workout_date = date.fromisoformat(workout["date"])
        if workout_date < start or workout_date > end:
            continue
        workout_ids.add(workout["id"])
        seen_in_workout: set[str] = set()
        for exercise in workout.get("exercises", []):
            if not isinstance(exercise, dict) or not isinstance(exercise.get("sets", []), list):
                raise InvalidTrend("exercise")
            exercise_id = exercise["exerciseId"]
            bucket = grouped.setdefault(
                exercise_id,
                {
                    "exerciseId": exercise_id,
                    "name": exercise["name"],
                    "type": exercise["type"],
                    "sessionCount": 0,
                    "volume": Decimal("0"),
                    "hasVolume": exercise["type"] != "duration",
                },
            )
            qualified = False
            for item in exercise.get("sets", []):
                if not isinstance(item, dict):
                    raise InvalidTrend("set")
                if exercise["type"] == "duration":
                    if item.get("durationSec"):
                        qualified = True
                    continue
                reps = item.get("reps")
                load = item.get("loadLb")
                if reps is None or load is None:
                    continue
                if exercise["type"] != "bodyweight":
                    bucket["volume"] += _number(load) * _number(reps)
                qualified = True
            if qualified and exercise_id not in seen_in_workout:
                bucket["sessionCount"] += 1
                seen_in_workout.add(exercise_id)

    weeks = Decimal(days) / Decimal(7)
    exercises = []
    for bucket in grouped.values():
        session_count = bucket["sessionCount"]
        frequency = (Decimal(session_count) / weeks).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if bucket["type"] == "duration" or not bucket["hasVolume"]:
            total = None
            average = None
        else:
            total_decimal = bucket["volume"].quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
            total = format(total_decimal, "f")
            average = (
                format((total_decimal / Decimal(session_count)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP), "f")
                if session_count
                else None
            )
        exercises.append(
            {
                "exerciseId": bucket["exerciseId"],
                "name": bucket["name"],
                "sessionCount": session_count,
                "totalVolumeLb": total,
                "averageVolumeLb": average,
                "frequencyPerWeek": format(frequency, "f"),
            }
        )
    return {
        "version": 1,
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "workoutCount": len(workout_ids),
        "exercises": exercises,
    }
