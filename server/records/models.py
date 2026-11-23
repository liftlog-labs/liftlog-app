from django.conf import settings
from django.db import models


class AccountSyncState(models.Model):
    owner = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="sync_state")
    cursor = models.PositiveIntegerField(default=0)
    cursor_floor = models.PositiveIntegerField(default=0)


class CloudConsent(models.Model):
    owner = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="cloud_consent")
    version = models.CharField(max_length=40)
    accepted_at = models.DateTimeField(auto_now_add=True)


class SyncOperation(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="sync_operations")
    op_id = models.CharField(max_length=80)
    fingerprint = models.CharField(max_length=64)
    result = models.JSONField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "op_id"], name="one_sync_operation")]


class Change(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="sync_changes")
    cursor = models.PositiveIntegerField()
    record_type = models.CharField(max_length=40)
    client_id = models.CharField(max_length=128)
    server_revision = models.PositiveIntegerField()
    deleted = models.BooleanField(default=False)
    payload = models.JSONField(null=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "cursor"], name="one_change_cursor")]


class Tombstone(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="tombstones")
    record_type = models.CharField(max_length=40)
    client_id = models.CharField(max_length=128)
    server_revision = models.PositiveIntegerField()
    deleted_at = models.DateTimeField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "record_type", "client_id"], name="one_tombstone")]


class Suppression(models.Model):
    account_public_id = models.UUIDField()
    email = models.EmailField()
    record_type = models.CharField(max_length=40)
    client_id = models.CharField(max_length=128)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["account_public_id", "record_type", "client_id"], name="one_suppression")
        ]


class ExerciseRecord(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="exercise_records")
    client_id = models.CharField(max_length=128)
    server_revision = models.PositiveIntegerField(default=1)
    exercise_type = models.CharField(max_length=20)
    name = models.CharField(max_length=120)
    bar_weight_lb = models.CharField(max_length=40, null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "client_id"], name="one_exercise_record")]


class ExerciseNameRecord(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="exercise_name_records")
    client_id = models.CharField(max_length=128)
    server_revision = models.PositiveIntegerField(default=1)
    exercise_client_id = models.CharField(max_length=128)
    name = models.CharField(max_length=120)
    canonical = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "client_id"], name="one_exercise_name_record")]


class WorkoutRecord(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="workout_records")
    client_id = models.CharField(max_length=128)
    server_revision = models.PositiveIntegerField(default=1)
    date = models.CharField(max_length=10)
    label = models.CharField(max_length=80, null=True, blank=True)
    started_at = models.CharField(max_length=40, null=True, blank=True)
    ended_at = models.CharField(max_length=40, null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "client_id"], name="one_workout_record")]


class WorkoutExerciseRecord(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="workout_exercise_records")
    client_id = models.CharField(max_length=128)
    server_revision = models.PositiveIntegerField(default=1)
    workout_client_id = models.CharField(max_length=128)
    exercise_client_id = models.CharField(max_length=128)
    position = models.PositiveIntegerField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "client_id"], name="one_workout_exercise_record")]


class SetRecord(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="set_records")
    client_id = models.CharField(max_length=128)
    server_revision = models.PositiveIntegerField(default=1)
    workout_exercise_client_id = models.CharField(max_length=128)
    position = models.PositiveIntegerField()
    load_lb = models.CharField(max_length=40, null=True, blank=True)
    reps = models.IntegerField(null=True)
    duration_sec = models.IntegerField(null=True)
    assisted = models.BooleanField(default=False)
    note = models.TextField(null=True, blank=True)
    logged_at = models.CharField(max_length=40, null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "client_id"], name="one_set_record")]


class TrainingProfileRecord(models.Model):
    owner = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="training_profile_record")
    client_id = models.CharField(max_length=128, default="local")
    server_revision = models.PositiveIntegerField(default=1)
    goal = models.CharField(max_length=40, null=True, blank=True)
    experience = models.CharField(max_length=40, null=True, blank=True)
    training_days = models.IntegerField(null=True)
    session_minutes = models.IntegerField(null=True)
    equipment_json = models.JSONField(null=True)
    preferences_json = models.JSONField(null=True)
