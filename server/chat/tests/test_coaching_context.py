import pytest
from django.contrib.auth import get_user_model
from records.models import AccountSyncState, WorkoutRecord, ExerciseRecord, WorkoutExerciseRecord, SetRecord
from chat.coaching_context import build_coaching_packet
from datetime import datetime, timezone

pytestmark = pytest.mark.django_db

def test_owned_bounded_context():
    user = get_user_model().objects.create_user(username='context-synthetic')
    other = get_user_model().objects.create_user(username='other-synthetic')
    AccountSyncState.objects.create(owner=user, cursor=7)
    for owner, prefix in [(user, 'own'), (other, 'foreign')]:
        ExerciseRecord.objects.create(owner=owner, client_id=prefix+'e', exercise_type='barbell', name='Barbell Back Squat')
        WorkoutRecord.objects.create(owner=owner, client_id=prefix+'w', date='2026-11-15', ended_at='2026-11-15T12:00:00Z')
        WorkoutExerciseRecord.objects.create(owner=owner, client_id=prefix+'we', workout_client_id=prefix+'w', exercise_client_id=prefix+'e', position=0)
        SetRecord.objects.create(owner=owner, client_id=prefix+'s', workout_exercise_client_id=prefix+'we', position=0, load_lb='100', reps=5, note='SECRET-NOTE')
    packet = build_coaching_packet(user, 'UTC', {'cursor':7,'pending':False,'conflicts':False}, datetime(2026,11,16,tzinfo=timezone.utc))
    assert packet['snapshot']['cursor'] == 7
    assert packet['context']['performedVolumeLb'] == '500'
    assert packet['context']['includedSetIds'] == ['owns']
    assert 'foreign' not in str(packet) and 'SECRET-NOTE' not in str(packet)
    assert len(packet['snapshot']['revision']) == 64
    assert len(packet['context']['revision']) == 64
    assert packet['allowedFocus'] == ['light', 'clarify']
    assert any('Missing logs' in text for text in packet['uncertainties'])

def test_shared_engine_parity_and_revision():
    from chat.coaching_context import run_context
    snapshot = {'asOf':'2026-11-16T12:00:00Z','timeZone':'UTC','profile':dict(goal=None, experience=None, trainingDays=None, sessionMinutes=None, equipment=None, preferences=None, updatedAt=None, revision=0),'performedSets':[], 'plannedSets':[], 'activeWorkout':None}
    first = run_context(snapshot)
    assert first['performedVolumeLb'] == '0'
    assert first['recentSessions'] == []
    assert first['localDate'] == '2026-11-16'
    snapshot['profile']['goal'] = 'strength'
    assert run_context(snapshot)['revision'] != first['revision']


def test_stale_and_invalid_zone_fail_closed():
    from chat.coaching_context import CoachingContextError
    user = get_user_model().objects.create_user(username='empty-synthetic')
    packet = build_coaching_packet(user, 'UTC', {'cursor':0,'pending':True,'conflicts':False}, datetime(2026,11,16,tzinfo=timezone.utc))
    assert any('stale' in x for x in packet['uncertainties'])
    assert any('incomplete' in x for x in packet['uncertainties'])
    with pytest.raises(CoachingContextError):
        build_coaching_packet(user, '../../secret', {})

def test_correction_deletion_overlap_and_stable_clock_revision():
    user = get_user_model().objects.create_user(username='correct-synthetic')
    AccountSyncState.objects.create(owner=user, cursor=2)
    e = ExerciseRecord.objects.create(owner=user, client_id='e', exercise_type='barbell', name='Barbell Back Squat')
    for number, date in [(1,'2026-11-14'),(2,'2026-11-15')]:
        WorkoutRecord.objects.create(owner=user, client_id=f'w{number}', date=date, ended_at=date+'T12:00:00Z')
        WorkoutExerciseRecord.objects.create(owner=user,client_id=f'we{number}',workout_client_id=f'w{number}',exercise_client_id=e.client_id,position=0)
        SetRecord.objects.create(owner=user,client_id=f's{number}',workout_exercise_client_id=f'we{number}',position=0,load_lb='100',reps=5)
    sync = {'cursor':2,'pending':False,'conflicts':False}
    now = datetime(2026,11,16,12,tzinfo=timezone.utc)
    before = build_coaching_packet(user,'UTC',sync,now)
    same_day = build_coaching_packet(user,'UTC',sync,now.replace(hour=13))
    assert before['snapshot']['revision'] == same_day['snapshot']['revision']
    assert before['allowedFocus'] == ['light','clarify','upper']
    SetRecord.objects.filter(owner=user,client_id='s2').update(load_lb='120')
    corrected = build_coaching_packet(user,'UTC',sync,now)
    assert corrected['context']['performedVolumeLb'] == '1100'
    assert corrected['snapshot']['revision'] != before['snapshot']['revision']
    SetRecord.objects.filter(owner=user,client_id='s2').delete()
    deleted = build_coaching_packet(user,'UTC',sync,now)
    assert deleted['context']['performedVolumeLb'] == '500'
    assert 'set:s2' not in [x['id'] for x in deleted['evidence']]

def test_empty_workouts_do_not_hide_performed_history_and_bad_profile_is_unknown():
    from records.models import TrainingProfileRecord
    user = get_user_model().objects.create_user(username='bounds-synthetic')
    AccountSyncState.objects.create(owner=user)
    TrainingProfileRecord.objects.create(owner=user, goal='bogus', equipment_json=['x'*10000], preferences_json=[{'exerciseId':'x'*10000,'stance':'prefer'}])
    for n in range(10):
        WorkoutRecord.objects.create(owner=user,client_id=f'empty{n}',date='2026-11-16',ended_at='2026-11-16T12:00:00Z')
    ExerciseRecord.objects.create(owner=user,client_id='e',name='Push-up',exercise_type='bodyweight')
    WorkoutRecord.objects.create(owner=user,client_id='performed',date='2026-11-15',ended_at='2026-11-15T12:00:00Z')
    WorkoutExerciseRecord.objects.create(owner=user,client_id='we',workout_client_id='performed',exercise_client_id='e',position=0)
    SetRecord.objects.create(owner=user,client_id='s',workout_exercise_client_id='we',position=0,reps=12)
    packet = build_coaching_packet(user,'UTC',{'cursor':0},datetime(2026,11,16,tzinfo=timezone.utc))
    assert packet['context']['includedSetIds'] == ['s']
    assert packet['context']['profile']['goal'] is None
    assert packet['context']['profile']['equipment'] is None
    assert any('Goal is unknown' in x for x in packet['uncertainties'])
    assert any('primary chest' in x['text'] for x in packet['evidence'])


def test_missing_runtime_fails_closed(monkeypatch):
    from chat import coaching_context
    monkeypatch.setattr(coaching_context,'NODE',None)
    with pytest.raises(coaching_context.CoachingContextError):
        coaching_context.run_context({})


def test_long_preferences_fit_the_mobile_evidence_contract():
    from records.models import TrainingProfileRecord
    user=get_user_model().objects.create_user(username='long-profile-synthetic')
    AccountSyncState.objects.create(owner=user)
    preferences=[]
    for n in range(12):
        identity=f'preferred-{n}'
        ExerciseRecord.objects.create(owner=user,client_id=identity,name='Synthetic '+str(n)+'x'*105,exercise_type='machine')
        preferences.append({'exerciseId':identity,'stance':'prefer'})
    TrainingProfileRecord.objects.create(owner=user,preferences_json=preferences)
    packet=build_coaching_packet(user,'UTC',{'cursor':0},datetime(2026,11,16,tzinfo=timezone.utc))
    assert len(packet['evidence'][0]['text'])<=1500
