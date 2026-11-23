import json
import uuid

import pytest
from rest_framework.test import APIClient

from records.models import ExerciseRecord, SetRecord
from records.service import compact_change_log, live_set_client_ids, operation_fingerprint

PASSWORD = "Liftlog-Test-Pass-1"


def register(email="ada@example.com"):
    client = APIClient()
    created = client.post(
        "/api/v1/auth/register",
        {"email": email, "password": PASSWORD, "displayName": "Ada"},
        format="json",
    )
    assert created.status_code == 201
    body = created.json()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {body['token']}")
    return client, body


def allow(client):
    response = client.post("/api/v1/account/consent", {"cloudSync": "2026-11-05"}, format="json")
    assert response.status_code == 200


def op(kind, record_type, client_id, base, payload, op_id=None):
    operation = {
        "opId": op_id or str(uuid.uuid4()),
        "kind": kind,
        "recordType": record_type,
        "clientId": client_id,
        "baseRevision": base,
        "payload": payload,
    }
    operation["fingerprint"] = operation_fingerprint(operation)
    return operation


def push(client, account_id, operations, association=None):
    body = {"accountId": account_id, "consent": {"cloudSync": "2026-11-05"}, "operations": operations}
    if association is not None:
        body["association"] = association
    return client.post("/api/v1/sync/push", body, format="json")


def exercise(client_id="ex-1", name="Custom Press", op_id=None):
    return op("upsert", "exercise", client_id, 0, {"type": "machine", "name": name, "barWeightLb": None}, op_id)


def workout(client_id="wo-1"):
    return op("upsert", "workout", client_id, 0, {"date": "2026-11-05", "label": "Legs", "startedAt": "2026-11-05T15:00:00.000Z", "endedAt": "2026-11-05T16:00:00.000Z"})


def entry(client_id="en-1", workout_id="wo-1", exercise_id="ex-1"):
    return op("upsert", "workout_exercise", client_id, 0, {"workoutId": workout_id, "exerciseId": exercise_id, "position": 1})


def set_op(client_id="set-1", entry_id="en-1", load="100", base=0, op_id=None):
    return op(
        "upsert",
        "workout_set",
        client_id,
        base,
        {
            "workoutExerciseId": entry_id,
            "position": 1,
            "loadLb": load,
            "reps": 5,
            "durationSec": None,
            "assisted": False,
            "note": None,
            "loggedAt": None,
        },
        op_id,
    )


@pytest.mark.django_db
def test_push_requires_consent_and_matching_account_and_replays_exactly():
    client, created = register()
    account_id = created["account"]["accountId"]
    denied = push(client, account_id, [exercise()])
    assert denied.status_code == 403
    assert denied.json()["code"] == "CONSENT_REQUIRED"
    assert ExerciseRecord.objects.count() == 0
    allow(client)
    forged = push(client, str(uuid.uuid4()), [exercise()])
    assert forged.status_code == 403
    first = exercise(op_id="op-1")
    saved = push(client, account_id, [first])
    assert saved.status_code == 200
    assert saved.json()["results"][0]["replayed"] is False
    again = push(client, account_id, [first])
    assert again.status_code == 200
    assert again.json()["results"][0]["replayed"] is True
    assert ExerciseRecord.objects.count() == 1
    changed = exercise(name="Other Press", op_id="op-1")
    mismatch = push(client, account_id, [changed])
    assert mismatch.status_code == 409
    assert mismatch.json()["code"] == "OPERATION_MISMATCH"
    assert ExerciseRecord.objects.get().name == "Custom Press"


@pytest.mark.django_db
def test_parents_conflicts_and_interrupted_batches_do_not_leak_across_accounts():
    ada, ada_body = register("ada@example.com")
    bee, bee_body = register("bee@example.com")
    allow(ada)
    allow(bee)
    ada_id = ada_body["account"]["accountId"]
    bee_id = bee_body["account"]["accountId"]
    graph = push(ada, ada_id, [exercise(), workout(), entry(), set_op()])
    assert graph.status_code == 200
    forged = push(bee, bee_id, [set_op(client_id="bee-set", entry_id="en-1")])
    assert forged.status_code == 409
    assert forged.json()["code"] == "PARENT_NOT_FOUND"
    assert list(SetRecord.objects.filter(owner__email="bee@example.com")) == []
    assert SetRecord.objects.get().load_lb == "100"
    stale = set_op(load="200", base=0, op_id="set-edit")
    conflict = push(ada, ada_id, [stale])
    assert conflict.status_code == 409
    assert conflict.json()["conflicts"][0]["rejected"]["loadLb"] == "200"
    assert conflict.json()["conflicts"][0]["server"]["payload"]["loadLb"] == "100"
    assert SetRecord.objects.get().load_lb == "100"
    edited = set_op(load="110", base=1, op_id="set-edit-2")
    assert push(ada, ada_id, [edited]).status_code == 200
    other_device = set_op(load="90", base=1, op_id="set-edit-3")
    race = push(ada, ada_id, [other_device])
    assert race.status_code == 409
    assert SetRecord.objects.get().load_lb == "110"
    partial = push(ada, ada_id, [exercise(client_id="ex-2", name="Row", op_id="row"), set_op(client_id="missing", entry_id="missing-parent", op_id="bad")])
    assert partial.status_code == 409
    assert ExerciseRecord.objects.filter(client_id="ex-2").count() == 0


@pytest.mark.django_db
def test_delete_hides_payloads_and_expired_cursors_recover_without_resurrecting():
    client, created = register()
    allow(client)
    account_id = created["account"]["accountId"]
    assert push(client, account_id, [exercise(), workout(), entry(), set_op()]).status_code == 200
    removal = op("delete", "workout_set", "set-1", 1, None, "delete-set")
    assert push(client, account_id, [removal]).status_code == 200
    stale = set_op(load="300", base=1, op_id="resurrect")
    assert push(client, account_id, [stale]).status_code == 409
    assert live_set_client_ids(created_user(client)) == []
    pulled = client.get("/api/v1/sync/pull?cursor=0&limit=20")
    assert pulled.status_code == 200
    assert "100" not in json.dumps(pulled.json())
    assert any(change["clientId"] == "set-1" and change["deleted"] is True and change["payload"] is None for change in pulled.json()["changes"])
    page = client.get("/api/v1/sync/pull?cursor=0&limit=1")
    assert page.json()["complete"] is False
    follow = client.get(f"/api/v1/sync/pull?cursor={page.json()['cursor']}&limit=1")
    assert follow.json()["changes"][0]["cursor"] != page.json()["changes"][0]["cursor"]
    user = created_user(client)
    from records.models import SetRecord as LiveSet

    LiveSet.objects.create(owner=user, client_id="set-1", server_revision=1, workout_exercise_client_id="en-1", position=1, load_lb="100", reps=5, assisted=False)
    from records.service import compact_change_log

    compact_change_log(user, user.sync_state.cursor)
    expired = client.get("/api/v1/sync/pull?cursor=1")
    assert expired.status_code == 409
    assert expired.json()["code"] == "CURSOR_EXPIRED"
    assert expired.json()["recovery"] == "full"
    restored = client.get("/api/v1/sync/pull?cursor=0&limit=50")
    assert "100" not in json.dumps(restored.json())
    assert live_set_client_ids(user) == []


def created_user(client):
    from django.contrib.auth.models import User

    return User.objects.get(email="ada@example.com")


@pytest.mark.django_db
def test_account_deletion_blocks_late_uploads_and_same_email_recreation():
    client, created = register()
    allow(client)
    account_id = created["account"]["accountId"]
    token = created["token"]
    assert push(client, account_id, [exercise(), workout(), entry(), set_op()]).status_code == 200
    wrong = client.post("/api/v1/account/delete", {"confirm": True, "password": "not-the-password"}, format="json")
    assert wrong.status_code == 401
    assert "not-the-password" not in json.dumps(wrong.json())
    assert SetRecord.objects.count() == 1
    removed = client.post("/api/v1/account/delete", {"confirm": True, "password": PASSWORD}, format="json")
    assert removed.status_code == 200
    assert removed.json()["accountId"] == account_id
    assert PASSWORD not in json.dumps(removed.json())
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    assert client.get("/api/v1/account").status_code == 401
    recreated, new_body = register("ada@example.com")
    assert new_body["account"]["accountId"] != account_id
    allow(recreated)
    late = push(recreated, account_id, [exercise(), workout(), entry(), set_op()])
    assert late.status_code == 410
    assert late.json()["code"] == "ACCOUNT_GONE"
    assert SetRecord.objects.count() == 0
    carried = push(recreated, new_body["account"]["accountId"], [exercise(), workout(), entry(), set_op()])
    assert carried.status_code == 409
    assert carried.json()["conflicts"][0]["code"] == "SUPPRESSED"
    assert SetRecord.objects.count() == 0
    associated = push(
        recreated,
        new_body["account"]["accountId"],
        [exercise(op_id="again-ex"), workout(client_id="wo-1"), entry(), set_op(op_id="again-set")],
        {"priorAccountId": account_id, "confirmed": True},
    )
    assert associated.status_code == 200
    assert live_set_client_ids(created_user(recreated)) == ["set-1"]


@pytest.mark.django_db
@pytest.mark.parametrize('case', ['account_uuid', 'kind_array', 'type_array', 'negative_position', 'oversized_integer'])
def test_malformed_sync_values_are_rejected_without_server_errors(case):
    client, created = register()
    allow(client)
    account_id = created['account']['accountId']
    operation = exercise()
    if case == 'account_uuid':
        account_id = 'synthetic-not-a-uuid'
    elif case == 'kind_array':
        operation['kind'] = []
    elif case == 'type_array':
        operation['payload']['type'] = []
    else:
        assert push(client, account_id, [exercise(), workout()]).status_code == 200
        operation = entry()
        operation['payload']['position'] = -1 if case == 'negative_position' else 2**100
    operation['fingerprint'] = operation_fingerprint(operation)
    response = push(client, account_id, [operation])
    assert response.status_code == 400
    assert response.json() == {'code': 'INVALID_INPUT'}
    assert ExerciseRecord.objects.count() == (1 if case in {'negative_position', 'oversized_integer'} else 0)

@pytest.mark.django_db
def test_debug_chat_bypass_does_not_open_account_sync(settings):
    from rest_framework.test import APIClient
    settings.DEBUG = True
    settings.LIFTLOG_LOCAL_DEV_OPEN = True
    client = APIClient()
    assert client.get('/api/v1/sync/pull').status_code in (401, 403)
    assert client.post('/api/v1/account/consent', {'cloudSync': '2026-11-05'}, format='json').status_code in (401, 403)

    assert client.post('/api/v1/sync/push', {}, format='json').status_code in (401, 403)


@pytest.mark.django_db
@pytest.mark.parametrize("include_descendant_deletes", [False, True])
@pytest.mark.parametrize("parent_type,parent_id", [("workout", "wo-1"), ("exercise", "ex-1"), ("workout_exercise", "en-1")])
def test_parent_deletion_erases_descendants_history_and_preserves_other_accounts(parent_type, parent_id, include_descendant_deletes):
    from records.models import Change, ExerciseNameRecord, Tombstone, WorkoutExerciseRecord
    client, created = register()
    other, other_created = register("other@example.com")
    allow(client)
    allow(other)
    account_id = created["account"]["accountId"]
    alias = op("upsert", "exercise_name", "alias-1", 0, {"exerciseId": "ex-1", "name": "Alias", "canonical": False})
    graph = [exercise(), alias, workout(), entry(), set_op()]
    assert push(client, account_id, graph).status_code == 200
    assert push(other, other_created["account"]["accountId"], graph).status_code == 200
    user = created_user(client)
    deletion = op("delete", parent_type, parent_id, 1, None)
    # Existing mobile clients send parents before descendant deletions.
    removals = [deletion]
    if include_descendant_deletes:
        if parent_type != "workout_exercise":
            removals.append(op("delete", "workout_exercise", "en-1", 1, None))
        removals.append(op("delete", "workout_set", "set-1", 1, None))
    response = push(client, account_id, removals)
    assert response.status_code == 200
    assert all(result["replayed"] for result in push(client, account_id, removals).json()["results"])
    assert not SetRecord.objects.filter(owner=user).exists()
    assert not WorkoutExerciseRecord.objects.filter(owner=user).exists()
    if parent_type == "exercise":
        assert not ExerciseNameRecord.objects.filter(owner=user).exists()
    deleted = list(Tombstone.objects.filter(owner=user).values_list("record_type", "client_id"))
    for record_type, client_id in deleted:
        assert not Change.objects.filter(owner=user, record_type=record_type, client_id=client_id, payload__isnull=False).exists()
    assert SetRecord.objects.filter(owner__email="other@example.com").count() == 1
    assert Change.objects.filter(owner__email="other@example.com", record_type="workout_set", payload__isnull=False).count() == 1
    assert push(client, account_id, [set_op(base=2)]).status_code == 409
    compact_change_log(user, user.sync_state.cursor)
    pulled = client.get("/api/v1/sync/pull").json()
    assert all(row["payload"] is None for row in pulled["changes"] if (row["recordType"], row["clientId"]) in deleted)


@pytest.mark.django_db
def test_direct_delete_erases_all_historical_payloads():
    from records.models import Change
    client, created = register()
    allow(client)
    account_id = created["account"]["accountId"]
    assert push(client, account_id, [exercise(), workout(), entry(), set_op()]).status_code == 200
    assert push(client, account_id, [set_op(load="110", base=1)]).status_code == 200
    assert push(client, account_id, [op("delete", "workout_set", "set-1", 2, None)]).status_code == 200
    assert not Change.objects.filter(owner=created_user(client), record_type="workout_set", payload__isnull=False).exists()


@pytest.mark.django_db
def test_alternate_profile_identity_is_rejected_without_mutation():
    from records.models import TrainingProfileRecord
    client, created = register()
    allow(client)
    payload = {"goal": None, "experience": None, "trainingDays": None, "sessionMinutes": None, "equipment": [], "preferences": []}
    account_id = created["account"]["accountId"]
    assert push(client, account_id, [op("upsert", "training_profile", "local", 0, payload)]).status_code == 200
    response = push(client, account_id, [op("upsert", "training_profile", "alternate", 0, payload)])
    assert response.status_code == 400
    assert response.json() == {"code": "INVALID_INPUT"}
    assert TrainingProfileRecord.objects.get().client_id == "local"


@pytest.mark.django_db
@pytest.mark.parametrize("field,limit", [("name", 120), ("clientId", 128), ("opId", 80), ("barWeightLb", 40)])
def test_sync_rejects_persisted_text_over_column_bounds(field, limit):
    client, created = register()
    allow(client)
    operation = exercise()
    target = operation if field in {"clientId", "opId"} else operation["payload"]
    target[field] = "S" * (limit + 1)
    operation["fingerprint"] = operation_fingerprint(operation)
    response = push(client, created["account"]["accountId"], [operation])
    assert response.status_code == 400
    assert response.json() == {"code": "INVALID_INPUT"}
    assert ExerciseRecord.objects.count() == 0


@pytest.mark.django_db
def test_cascading_delete_rolls_back_when_later_operation_fails():
    from records.models import Change, Tombstone, Suppression
    client, created = register()
    allow(client)
    account_id = created["account"]["accountId"]
    assert push(client, account_id, [exercise(), workout(), entry(), set_op()]).status_code == 200
    removals = [op("delete", "workout", "wo-1", 1, None), set_op(client_id="missing", entry_id="missing")]
    assert push(client, account_id, removals).status_code == 409
    assert SetRecord.objects.count() == 1
    assert Change.objects.filter(record_type="workout_set", payload__isnull=False).count() == 1
    assert Tombstone.objects.count() == Suppression.objects.count() == 0
    assert push(client, account_id, [removals[0]]).status_code == 200


@pytest.mark.django_db
def test_authenticated_pull_cannot_recreate_state_after_account_deletion():
    from accounts.models import AuthSession
    from records.models import AccountSyncState
    from records.service import SyncError, pull_changes

    client, created = register()
    session = AuthSession.objects.get(user__email=created["account"]["email"])
    stale_user = session.user
    deleted = client.post("/api/v1/account/delete", {"confirm": True, "password": PASSWORD}, format="json")
    assert deleted.status_code == 200
    with pytest.raises(SyncError) as error:
        pull_changes(stale_user, 0, 100)
    assert error.value.code == "ACCOUNT_GONE"
    assert not AccountSyncState.objects.filter(owner_id=stale_user.pk).exists()


@pytest.mark.django_db(transaction=True)
def test_postgres_concurrent_push_replays_and_conflicts():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import connection, connections

    if connection.vendor != "postgresql":
        pytest.skip("Requires PostgreSQL row locks")

    client, created = register()
    allow(client)
    account_id = created["account"]["accountId"]

    def race(left, right):
        barrier = Barrier(2, timeout=5)

        def submit(operation):
            worker = APIClient()
            worker.credentials(HTTP_AUTHORIZATION=f"Bearer {created['token']}")
            try:
                barrier.wait()
                response = push(worker, account_id, [operation])
                return response.status_code, response.json()
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(submit, (left, right)))

    first = exercise()
    replay = race(first, first)
    assert [status for status, _ in replay] == [200, 200]
    assert sorted(body["results"][0]["replayed"] for _, body in replay) == [False, True]
    updates = [
        op("upsert", "exercise", first["clientId"], 1,
           {"type": "machine", "name": name, "barWeightLb": None})
        for name in ("Synthetic A", "Synthetic B")
    ]
    results = race(*updates)
    assert sorted(status for status, _ in results) == [200, 409]
    assert next(body["code"] for status, body in results if status == 409) == "CONFLICT"
    assert ExerciseRecord.objects.get().server_revision == 2
