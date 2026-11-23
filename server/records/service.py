import hashlib
import json
import re
import uuid

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from accounts.models import AuthSession, DeletedAccount
from records.models import (
    AccountSyncState,
    Change,
    CloudConsent,
    ExerciseNameRecord,
    ExerciseRecord,
    SetRecord,
    Suppression,
    SyncOperation,
    Tombstone,
    TrainingProfileRecord,
    WorkoutExerciseRecord,
    WorkoutRecord,
)

CLOUD_SYNC_VERSION = "2026-11-05"
MAX_PUSH = 50
MAX_PULL = 200
RECORD_TYPES = ("exercise", "exercise_name", "workout", "workout_exercise", "workout_set", "training_profile")
EXERCISE_TYPES = {"barbell", "dumbbell", "machine", "bodyweight", "duration"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

MODELS = {
    "exercise": ExerciseRecord,
    "exercise_name": ExerciseNameRecord,
    "workout": WorkoutRecord,
    "workout_exercise": WorkoutExerciseRecord,
    "workout_set": SetRecord,
    "training_profile": TrainingProfileRecord,
}


class SyncError(Exception):
    def __init__(self, code: str, status: int, extra: dict | None = None):
        self.code = code
        self.status = status
        self.extra = extra or {}


def operation_fingerprint(operation: dict) -> str:
    body = {
        "baseRevision": operation.get("baseRevision"),
        "clientId": operation.get("clientId"),
        "kind": operation.get("kind"),
        "payload": operation.get("payload"),
        "recordType": operation.get("recordType"),
    }
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _lock_active_account(user):
    # Take the user lock before the sync-state lock, as Coach does.
    locked = get_user_model().objects.select_for_update().filter(pk=user.pk, is_active=True).first()
    if locked is None:
        raise SyncError("ACCOUNT_GONE", 410)
    return locked


@transaction.atomic
def grant_cloud_consent(user, data: dict) -> dict:
    if not isinstance(data, dict) or set(data) - {"cloudSync"}:
        raise SyncError("INVALID_INPUT", 400)
    if data.get("cloudSync") != CLOUD_SYNC_VERSION:
        raise SyncError("INVALID_INPUT", 400)
    user = _lock_active_account(user)
    CloudConsent.objects.update_or_create(owner=user, defaults={"version": CLOUD_SYNC_VERSION})
    return {"cloudSync": CLOUD_SYNC_VERSION}


def cloud_consent_version(user) -> str | None:
    consent = CloudConsent.objects.filter(owner=user).first()
    return consent.version if consent else None


def push_batch(user, data: dict) -> dict:
    with transaction.atomic():
        user = _lock_active_account(user)
        operations = _validate_batch(user, data)
        AccountSyncState.objects.get_or_create(owner=user)
        state = AccountSyncState.objects.select_for_update().get(owner=user)
        mismatches = []
        for operation in operations:
            existing = SyncOperation.objects.filter(owner=user, op_id=operation["opId"]).first()
            if existing and existing.fingerprint != operation["fingerprint"]:
                mismatches.append(operation["opId"])
        if mismatches:
            raise SyncError("OPERATION_MISMATCH", 409, {"opIds": mismatches})
        results = []
        conflicts = []
        for operation in operations:
            existing = SyncOperation.objects.filter(owner=user, op_id=operation["opId"]).first()
            if existing:
                replay = dict(existing.result)
                replay["replayed"] = True
                results.append(replay)
                continue
            outcome = _apply_operation(user, state, operation, data.get("association"))
            if outcome.get("conflict"):
                conflicts.append(outcome["conflict"])
            else:
                results.append(outcome["result"])
        if conflicts:
            raise SyncError("CONFLICT", 409, {"conflicts": conflicts, "rejected": [_rejected(operation) for operation in operations]})
        for operation, result in zip(operations, results, strict=True):
            if result.get("replayed"):
                continue
            SyncOperation.objects.create(owner=user, op_id=operation["opId"], fingerprint=operation["fingerprint"], result=result)
        state.save(update_fields=["cursor", "cursor_floor"])
    return {"accountId": str(user.account_profile.public_id), "cursor": state.cursor, "results": results}


@transaction.atomic
def pull_changes(user, cursor: int, limit: int) -> dict:
    if limit < 1 or limit > MAX_PULL:
        raise SyncError("INVALID_INPUT", 400)
    user = _lock_active_account(user)
    AccountSyncState.objects.get_or_create(owner=user)
    state = AccountSyncState.objects.select_for_update().get(owner=user)
    if cursor != 0 and (cursor < state.cursor_floor or cursor > state.cursor):
        raise SyncError("CURSOR_EXPIRED", 409, {"recovery": "full", "cursor": state.cursor})
    since = state.cursor_floor if cursor == 0 else cursor
    rows = list(Change.objects.filter(owner=user, cursor__gt=since).order_by("cursor")[: limit + 1])
    complete = len(rows) <= limit
    page = rows[:limit]
    hidden = set(Tombstone.objects.filter(owner=user).values_list("record_type", "client_id"))
    next_cursor = page[-1].cursor if page else since
    return {
        "accountId": str(user.account_profile.public_id),
        "cursor": next_cursor,
        "complete": complete,
        "changes": [_change_body(row, hidden) for row in page],
    }


def compact_change_log(user, floor: int) -> None:
    with transaction.atomic():
        user = _lock_active_account(user)
        state = AccountSyncState.objects.select_for_update().get(owner=user)
        if floor < 0 or floor > state.cursor:
            raise SyncError("INVALID_INPUT", 400)
        Change.objects.filter(owner=user, cursor__lte=floor).delete()
        state.cursor_floor = floor
        state.save(update_fields=["cursor_floor"])
        for record_type, model in MODELS.items():
            hidden = set(Tombstone.objects.filter(owner=user, record_type=record_type).values_list("client_id", flat=True))
            for row in model.objects.filter(owner=user):
                if row.client_id in hidden:
                    continue
                _append_change(state, user, record_type, row.client_id, row.server_revision, False, _payload(row, record_type))
            for tombstone in Tombstone.objects.filter(owner=user, record_type=record_type):
                _append_change(state, user, record_type, tombstone.client_id, tombstone.server_revision, True, None)
        state.save(update_fields=["cursor"])


def live_set_client_ids(user) -> list[str]:
    deleted = Tombstone.objects.filter(owner=user, record_type="workout_set").values_list("client_id", flat=True)
    return list(SetRecord.objects.filter(owner=user).exclude(client_id__in=deleted).order_by("client_id").values_list("client_id", flat=True))


def erase_account(user) -> str:
    user = _lock_active_account(user)
    profile = user.account_profile
    public_id = profile.public_id
    email = user.email
    now = timezone.now()
    AuthSession.objects.filter(user=user, revoked_at__isnull=True).update(revoked_at=now)
    AccountSyncState.objects.get_or_create(owner=user)
    state = AccountSyncState.objects.select_for_update().get(owner=user)
    for record_type, model in MODELS.items():
        for row in list(model.objects.filter(owner=user)):
            _suppress(public_id, email, record_type, row.client_id, now, state, user, row.server_revision + 1)
            row.delete()
    DeletedAccount.objects.create(public_id=public_id, email=email)
    state.save(update_fields=["cursor"])
    user.delete()
    return str(public_id)


def _validate_batch(user, data: dict) -> list[dict]:
    if not isinstance(data, dict):
        raise SyncError("INVALID_INPUT", 400)
    allowed = {"accountId", "consent", "operations", "association"}
    if set(data) - allowed:
        raise SyncError("INVALID_INPUT", 400)
    account_id = data.get("accountId")
    if not isinstance(account_id, str):
        raise SyncError("INVALID_INPUT", 400)
    try:
        uuid.UUID(account_id)
    except (ValueError, AttributeError):
        raise SyncError("INVALID_INPUT", 400) from None
    if DeletedAccount.objects.filter(public_id=account_id).exists():
        raise SyncError("ACCOUNT_GONE", 410)
    if str(user.account_profile.public_id) != account_id:
        raise SyncError("FORBIDDEN", 403)
    consent = data.get("consent")
    if not isinstance(consent, dict) or consent.get("cloudSync") != CLOUD_SYNC_VERSION:
        raise SyncError("CONSENT_REQUIRED", 403)
    if cloud_consent_version(user) != CLOUD_SYNC_VERSION:
        raise SyncError("CONSENT_REQUIRED", 403)
    operations = data.get("operations")
    if not isinstance(operations, list) or not operations or len(operations) > MAX_PUSH:
        raise SyncError("INVALID_INPUT", 400)
    prepared = []
    seen = set()
    for operation in operations:
        prepared.append(_prepare_operation(operation))
        if prepared[-1]["opId"] in seen:
            raise SyncError("INVALID_INPUT", 400)
        seen.add(prepared[-1]["opId"])
    association = data.get("association")
    if association is not None:
        if not isinstance(association, dict) or set(association) - {"priorAccountId", "confirmed"}:
            raise SyncError("INVALID_INPUT", 400)
        if association.get("confirmed") is not True or not isinstance(association.get("priorAccountId"), str):
            raise SyncError("INVALID_INPUT", 400)
    return prepared


def _prepare_operation(operation: dict) -> dict:
    if not isinstance(operation, dict):
        raise SyncError("INVALID_INPUT", 400)
    if set(operation) - {"opId", "fingerprint", "kind", "recordType", "clientId", "baseRevision", "payload"}:
        raise SyncError("INVALID_INPUT", 400)
    if not isinstance(operation.get("kind"), str) or operation.get("kind") not in {"upsert", "delete"} or operation.get("recordType") not in RECORD_TYPES:
        raise SyncError("INVALID_INPUT", 400)
    if (not isinstance(operation.get("opId"), str) or not 1 <= len(operation["opId"]) <= 80
            or not isinstance(operation.get("clientId"), str) or not 1 <= len(operation["clientId"]) <= 128):
        raise SyncError("INVALID_INPUT", 400)
    if not isinstance(operation.get("fingerprint"), str) or type(operation.get("baseRevision")) is not int or operation["baseRevision"] < 0:
        raise SyncError("INVALID_INPUT", 400)
    if operation["recordType"] == "training_profile" and operation["clientId"] != "local":
        raise SyncError("INVALID_INPUT", 400)
    payload = operation.get("payload")
    if operation["kind"] == "delete":
        payload = None
    elif not isinstance(payload, dict) or {"ownerId", "userId", "accountId"} & set(payload):
        raise SyncError("INVALID_INPUT", 400)
    else:
        _validate_payload(operation["recordType"], payload)
    prepared = {
        "opId": operation["opId"],
        "fingerprint": operation["fingerprint"],
        "kind": operation["kind"],
        "recordType": operation["recordType"],
        "clientId": operation["clientId"],
        "baseRevision": operation["baseRevision"],
        "payload": payload,
    }
    if prepared["fingerprint"] != operation_fingerprint(prepared):
        raise SyncError("FINGERPRINT_MISMATCH", 400)
    return prepared


def _validate_payload(record_type: str, payload: dict) -> None:
    # CharField limits are not enforced by SQLite. Bound persisted strings here.
    limits = {"name": 120, "exerciseId": 128, "workoutId": 128, "workoutExerciseId": 128,
              "barWeightLb": 40, "label": 80, "startedAt": 40, "endedAt": 40,
              "loadLb": 40, "loggedAt": 40, "goal": 40, "experience": 40}
    if any(isinstance(payload.get(key), str) and len(payload[key]) > limit for key, limit in limits.items()):
        raise SyncError("INVALID_INPUT", 400)
    # Match the database integer domain before writing; SQLite rejects overflow
    # and the position columns have a nonnegative constraint.
    for key in ("position", "reps", "durationSec", "trainingDays", "sessionMinutes"):
        value = payload.get(key)
        if type(value) is int and not -(2**63) <= value < 2**63:
            raise SyncError("INVALID_INPUT", 400)
    if type(payload.get("position")) is int and payload["position"] < 0:
        raise SyncError("INVALID_INPUT", 400)
    if record_type == "exercise":
        _require_keys(payload, {"type", "name", "barWeightLb"})
        if not isinstance(payload["type"], str) or payload["type"] not in EXERCISE_TYPES or not isinstance(payload["name"], str) or not payload["name"].strip():
            raise SyncError("INVALID_INPUT", 400)
        if payload["barWeightLb"] is not None and not isinstance(payload["barWeightLb"], str):
            raise SyncError("INVALID_INPUT", 400)
    elif record_type == "exercise_name":
        _require_keys(payload, {"exerciseId", "name", "canonical"})
        if not isinstance(payload["exerciseId"], str) or not isinstance(payload["name"], str) or type(payload["canonical"]) is not bool:
            raise SyncError("INVALID_INPUT", 400)
    elif record_type == "workout":
        _require_keys(payload, {"date", "label", "startedAt", "endedAt"})
        if not isinstance(payload["date"], str) or not DATE_RE.match(payload["date"]):
            raise SyncError("INVALID_INPUT", 400)
        for key in ("label", "startedAt", "endedAt"):
            if payload[key] is not None and not isinstance(payload[key], str):
                raise SyncError("INVALID_INPUT", 400)
    elif record_type == "workout_exercise":
        _require_keys(payload, {"workoutId", "exerciseId", "position"})
        if not isinstance(payload["workoutId"], str) or not isinstance(payload["exerciseId"], str) or type(payload["position"]) is not int:
            raise SyncError("INVALID_INPUT", 400)
    elif record_type == "workout_set":
        _require_keys(payload, {"workoutExerciseId", "position", "loadLb", "reps", "durationSec", "assisted", "note", "loggedAt"})
        if not isinstance(payload["workoutExerciseId"], str) or type(payload["position"]) is not int or type(payload["assisted"]) is not bool:
            raise SyncError("INVALID_INPUT", 400)
        if payload["loadLb"] is not None and not isinstance(payload["loadLb"], str):
            raise SyncError("INVALID_INPUT", 400)
        if payload["reps"] is not None and type(payload["reps"]) is not int:
            raise SyncError("INVALID_INPUT", 400)
        if payload["durationSec"] is not None and type(payload["durationSec"]) is not int:
            raise SyncError("INVALID_INPUT", 400)
        if payload["note"] is not None and not isinstance(payload["note"], str):
            raise SyncError("INVALID_INPUT", 400)
        if payload["loggedAt"] is not None and not isinstance(payload["loggedAt"], str):
            raise SyncError("INVALID_INPUT", 400)
    elif record_type == "training_profile":
        _require_keys(payload, {"goal", "experience", "trainingDays", "sessionMinutes", "equipment", "preferences"})
        for key in ("goal", "experience"):
            if payload[key] is not None and not isinstance(payload[key], str):
                raise SyncError("INVALID_INPUT", 400)
        for key in ("trainingDays", "sessionMinutes"):
            if payload[key] is not None and type(payload[key]) is not int:
                raise SyncError("INVALID_INPUT", 400)
        if payload["equipment"] is not None and not isinstance(payload["equipment"], list):
            raise SyncError("INVALID_INPUT", 400)
        if payload["preferences"] is not None and not isinstance(payload["preferences"], list):
            raise SyncError("INVALID_INPUT", 400)


def _apply_operation(user, state, operation: dict, association) -> dict:
    record_type = operation["recordType"]
    client_id = operation["clientId"]
    current = _identity(user, record_type, client_id)
    # A parent may already have cascaded this deletion earlier in the same batch.
    # Terminal deletes are idempotent; a future revision still indicates bad input.
    if operation["kind"] == "delete" and current and current["deleted"] and operation["baseRevision"] <= current["revision"]:
        return {"result": _result(operation, current["revision"], None, "deleted")}
    if _blocked_by_other_account(user, record_type, client_id, association):
        return {"conflict": _conflict(operation, current, "SUPPRESSED")}
    if operation["kind"] == "upsert" and current and current["deleted"]:
        return {"conflict": _conflict(operation, current, "CONFLICT")}
    expected = 0 if current is None else current["revision"]
    if operation["baseRevision"] != expected:
        return {"conflict": _conflict(operation, current, "CONFLICT")}
    if operation["kind"] == "delete":
        revision = expected + 1
        _delete_record(user, state, record_type, client_id, revision, timezone.now())
        return {"result": _result(operation, revision, state.cursor, "deleted")}
    _require_parents(user, record_type, operation["payload"])
    revision = 1 if current is None else expected + 1
    row = _write_row(user, record_type, client_id, revision, operation["payload"], None if current is None else current["row"])
    cursor = _append_change(state, user, record_type, client_id, revision, False, _payload(row, record_type))
    return {"result": _result(operation, revision, cursor, "applied")}


def _blocked_by_other_account(user, record_type: str, client_id: str, association) -> bool:
    prior = None
    if isinstance(association, dict) and association.get("confirmed") is True:
        prior = association.get("priorAccountId")
    for suppression in Suppression.objects.filter(email=user.email, record_type=record_type, client_id=client_id):
        if suppression.account_public_id == user.account_profile.public_id:
            return True
        if str(suppression.account_public_id) != prior:
            return True
    return False


def _require_parents(user, record_type: str, payload: dict) -> None:
    if record_type == "exercise_name":
        parent = _identity(user, "exercise", payload["exerciseId"])
        if parent is None or parent["deleted"]:
            raise SyncError("PARENT_NOT_FOUND", 409)
    elif record_type == "workout_exercise":
        workout = _identity(user, "workout", payload["workoutId"])
        exercise = _identity(user, "exercise", payload["exerciseId"])
        if workout is None or workout["deleted"] or exercise is None or exercise["deleted"]:
            raise SyncError("PARENT_NOT_FOUND", 409)
    elif record_type == "workout_set":
        parent = _identity(user, "workout_exercise", payload["workoutExerciseId"])
        if parent is None or parent["deleted"]:
            raise SyncError("PARENT_NOT_FOUND", 409)


def _write_row(user, record_type: str, client_id: str, revision: int, payload: dict, row):
    if record_type == "exercise":
        values = {"exercise_type": payload["type"], "name": payload["name"].strip(), "bar_weight_lb": payload["barWeightLb"], "server_revision": revision}
    elif record_type == "exercise_name":
        values = {"exercise_client_id": payload["exerciseId"], "name": payload["name"].strip(), "canonical": payload["canonical"], "server_revision": revision}
    elif record_type == "workout":
        values = {"date": payload["date"], "label": payload["label"], "started_at": payload["startedAt"], "ended_at": payload["endedAt"], "server_revision": revision}
    elif record_type == "workout_exercise":
        values = {"workout_client_id": payload["workoutId"], "exercise_client_id": payload["exerciseId"], "position": payload["position"], "server_revision": revision}
    elif record_type == "workout_set":
        values = {
            "workout_exercise_client_id": payload["workoutExerciseId"],
            "position": payload["position"],
            "load_lb": payload["loadLb"],
            "reps": payload["reps"],
            "duration_sec": payload["durationSec"],
            "assisted": payload["assisted"],
            "note": payload["note"],
            "logged_at": payload["loggedAt"],
            "server_revision": revision,
        }
    else:
        values = {
            "goal": payload["goal"],
            "experience": payload["experience"],
            "training_days": payload["trainingDays"],
            "session_minutes": payload["sessionMinutes"],
            "equipment_json": payload["equipment"],
            "preferences_json": payload["preferences"],
            "server_revision": revision,
        }
    if row is None:
        return MODELS[record_type].objects.create(owner=user, client_id=client_id, **values)
    for key, value in values.items():
        setattr(row, key, value)
    row.save()
    return row


def _delete_record(user, state, record_type: str, client_id: str, revision: int, now) -> None:
    children = []
    if record_type == "exercise":
        children = [("exercise_name", ExerciseNameRecord.objects.filter(owner=user, exercise_client_id=client_id)),
                    ("workout_exercise", WorkoutExerciseRecord.objects.filter(owner=user, exercise_client_id=client_id))]
    elif record_type == "workout":
        children = [("workout_exercise", WorkoutExerciseRecord.objects.filter(owner=user, workout_client_id=client_id))]
    elif record_type == "workout_exercise":
        children = [("workout_set", SetRecord.objects.filter(owner=user, workout_exercise_client_id=client_id))]
    for child_type, rows in children:
        for row in list(rows):
            _delete_record(user, state, child_type, row.client_id, row.server_revision + 1, now)
    MODELS[record_type].objects.filter(owner=user, client_id=client_id).delete()
    _suppress(user.account_profile.public_id, user.email, record_type, client_id, now, state, user, revision)


def _suppress(public_id, email: str, record_type: str, client_id: str, now, state, user, revision: int) -> None:
    # Keep cursors and operation receipts, but erase deleted content at rest too.
    Change.objects.filter(owner=user, record_type=record_type, client_id=client_id).update(payload=None)
    Tombstone.objects.update_or_create(
        owner=user,
        record_type=record_type,
        client_id=client_id,
        defaults={"server_revision": revision, "deleted_at": now},
    )
    Suppression.objects.get_or_create(account_public_id=public_id, email=email, record_type=record_type, client_id=client_id)
    _append_change(state, user, record_type, client_id, revision, True, None)


def _identity(user, record_type: str, client_id: str):
    tombstone = Tombstone.objects.filter(owner=user, record_type=record_type, client_id=client_id).first()
    if tombstone:
        return {"deleted": True, "revision": tombstone.server_revision, "row": None}
    row = MODELS[record_type].objects.filter(owner=user, client_id=client_id).first()
    if row is None:
        return None
    return {"deleted": False, "revision": row.server_revision, "row": row}


def _append_change(state, user, record_type: str, client_id: str, revision: int, deleted: bool, payload) -> int:
    state.cursor += 1
    Change.objects.create(
        owner=user,
        cursor=state.cursor,
        record_type=record_type,
        client_id=client_id,
        server_revision=revision,
        deleted=deleted,
        payload=None if deleted else payload,
    )
    return state.cursor


def _payload(row, record_type: str) -> dict:
    if record_type == "exercise":
        return {"type": row.exercise_type, "name": row.name, "barWeightLb": row.bar_weight_lb}
    if record_type == "exercise_name":
        return {"exerciseId": row.exercise_client_id, "name": row.name, "canonical": row.canonical}
    if record_type == "workout":
        return {"date": row.date, "label": row.label, "startedAt": row.started_at, "endedAt": row.ended_at}
    if record_type == "workout_exercise":
        return {"workoutId": row.workout_client_id, "exerciseId": row.exercise_client_id, "position": row.position}
    if record_type == "workout_set":
        return {
            "workoutExerciseId": row.workout_exercise_client_id,
            "position": row.position,
            "loadLb": row.load_lb,
            "reps": row.reps,
            "durationSec": row.duration_sec,
            "assisted": row.assisted,
            "note": row.note,
            "loggedAt": row.logged_at,
        }
    return {
        "goal": row.goal,
        "experience": row.experience,
        "trainingDays": row.training_days,
        "sessionMinutes": row.session_minutes,
        "equipment": row.equipment_json,
        "preferences": row.preferences_json,
    }


def _result(operation: dict, revision: int, cursor: int | None, status: str) -> dict:
    return {
        "opId": operation["opId"],
        "clientId": operation["clientId"],
        "recordType": operation["recordType"],
        "serverRevision": revision,
        "cursor": cursor,
        "status": status,
        "replayed": False,
    }


def _conflict(operation: dict, current, code: str) -> dict:
    server = None
    if current:
        server = {
            "recordType": operation["recordType"],
            "clientId": operation["clientId"],
            "serverRevision": current["revision"],
            "deleted": current["deleted"],
            "payload": None if current["deleted"] or current["row"] is None else _payload(current["row"], operation["recordType"]),
        }
    return {"opId": operation["opId"], "code": code, "server": server, "rejected": operation.get("payload")}


def _rejected(operation: dict) -> dict:
    return {"opId": operation["opId"], "recordType": operation["recordType"], "clientId": operation["clientId"], "payload": operation.get("payload")}


def _change_body(row: Change, hidden: set[tuple[str, str]]) -> dict:
    deleted = row.deleted or (row.record_type, row.client_id) in hidden
    return {
        "cursor": row.cursor,
        "recordType": row.record_type,
        "clientId": row.client_id,
        "serverRevision": row.server_revision,
        "deleted": deleted,
        "payload": None if deleted else row.payload,
    }


def _require_keys(payload: dict, keys: set[str]) -> None:
    if set(payload) != keys:
        raise SyncError("INVALID_INPUT", 400)
