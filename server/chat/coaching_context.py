"""Account-owned, bounded read-only snapshot; calculations use the app's TS engine."""
import hashlib
import json
import shutil
import subprocess
from datetime import timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.db.models import TextField, Exists, OuterRef, Q
from django.db.models.functions import Cast, Substr
from django.utils import timezone
from records.models import AccountSyncState, ExerciseRecord, SetRecord, TrainingProfileRecord, WorkoutExerciseRecord, WorkoutRecord

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which('node')  # resolved once; never request-controlled
BRIDGE = ROOT / 'scripts' / 'personal-context.mjs'

class CoachingContextError(Exception):
    pass

def _text(value, limit):
    return value[:limit] if isinstance(value, str) else ''

def _choice(value, choices):
    return value if value in choices else None

def _integer(value, low, high):
    return value if type(value) is int and low <= value <= high else None

def run_context(snapshot):
    body = json.dumps(snapshot, separators=(',', ':'), ensure_ascii=True).encode()
    if not NODE or len(body) > 262144:
        raise CoachingContextError('CONTEXT_UNAVAILABLE')
    try:
        # A bounded stdin and engine-bounded stdout; stderr is never logged or returned.
        result = subprocess.run([NODE, '--disable-warning=ExperimentalWarning', str(BRIDGE)], input=body,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=True,
            cwd=ROOT, env={'LANG':'C.UTF-8', 'TZ':'UTC'})
        if len(result.stdout) > 65536:
            raise ValueError()
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise CoachingContextError('CONTEXT_UNAVAILABLE') from exc

# Exact names only: custom or renamed exercises remain unknown. These describe
# involvement, never readiness, recovery, injury or an inferred completed plan.
GROUPS = {
    'barbell back squat': ('lower', 'quadriceps/glutes', 'hamstrings/trunk'),
    'back squat': ('lower', 'quadriceps/glutes', 'hamstrings/trunk'),
    'barbell squat': ('lower', 'quadriceps/glutes', 'hamstrings/trunk'),
    'conventional deadlift': ('lower', 'glutes/hamstrings', 'back/grip'),
    'lat pulldown': ('upper', 'back', 'biceps/grip'),
    'push-up': ('upper', 'chest', 'triceps/front deltoids'),
    'deadlift': ('lower', 'glutes/hamstrings', 'back/grip'),
    'barbell deadlift': ('lower', 'glutes/hamstrings', 'back/grip'),
    'romanian deadlift': ('lower', 'hamstrings/glutes', 'back/grip'),
    'leg press': ('lower', 'quadriceps/glutes', 'hamstrings'),
    'bench press': ('upper', 'chest', 'triceps/front deltoids'),
    'barbell bench press': ('upper', 'chest', 'triceps/front deltoids'),
    'overhead press': ('upper', 'deltoids', 'triceps'),
    'barbell overhead press': ('upper', 'deltoids', 'triceps'),
    'pull up': ('upper', 'back', 'biceps/grip'),
    'pull-up': ('upper', 'back', 'biceps/grip'),
    'barbell row': ('upper', 'back', 'biceps/rear deltoids'),
    'dumbbell row': ('upper', 'back', 'biceps/rear deltoids'),
}

def build_coaching_packet(user, time_zone, sync, now=None):
    try:
        if not isinstance(time_zone, str) or not 1 <= len(time_zone) <= 80:
            raise ValueError()
        zone = ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
        raise CoachingContextError('INVALID_TIME_ZONE') from exc
    now = now or timezone.now()
    local_date = now.astimezone(zone).date()
    profile = dict(goal=None, experience=None, trainingDays=None, sessionMinutes=None, equipment=None, preferences=None, updatedAt=None, revision=0)
    performed = []
    clipped = False
    with transaction.atomic():
        # Same lock as push_batch; all owner queries occur while it is held.
        state = AccountSyncState.objects.select_for_update().filter(owner=user).first()
        cursor = state.cursor if state else 0
        snapshot_owner = user if state else None
        p = TrainingProfileRecord.objects.filter(owner=snapshot_owner).annotate(equipment_bounded=Substr(Cast('equipment_json', TextField()),1,4097), preferences_bounded=Substr(Cast('preferences_json', TextField()),1,4097)).values('goal','experience','training_days','session_minutes','equipment_bounded','preferences_bounded','server_revision').first()
        if p:
            for field in ('equipment', 'preferences'):
                raw = p[field+'_bounded']
                try:
                    p[field+'_json'] = json.loads(raw) if raw and len(raw)<=4096 else None
                except (ValueError, TypeError):
                    p[field+'_json'] = None
        if p:
            profile.update(goal=_choice(p['goal'], ('hypertrophy','strength','general_fitness')), experience=_choice(p['experience'], ('beginner','intermediate','experienced')), trainingDays=_integer(p['training_days'],1,7), sessionMinutes=_integer(p['session_minutes'],15,180), revision=p['server_revision'])
            if isinstance(p['equipment_json'], list):
                profile['equipment'] = [x for x in p['equipment_json'][:12] if isinstance(x,str) and x in ('barbell','dumbbell','machine','cable','bodyweight')]
            if isinstance(p['preferences_json'], list):
                profile['preferences'] = [{'exerciseId':_text(x['exerciseId'],128),'stance':x['stance']} for x in p['preferences_json'][:12] if isinstance(x,dict) and isinstance(x.get('exerciseId'),str) and x.get('stance') in ('prefer','avoid')]
        performed_links = WorkoutExerciseRecord.objects.filter(owner=snapshot_owner, workout_client_id=OuterRef('client_id'), client_id__in=SetRecord.objects.filter(owner=snapshot_owner).values('workout_exercise_client_id'))
        workouts = list(WorkoutRecord.objects.annotate(has_sets=Exists(performed_links)).filter(has_sets=True, owner=snapshot_owner, date__gte=str(local_date-timedelta(days=27)), date__lte=str(local_date), ended_at__isnull=False).exclude(ended_at='').order_by('-date','client_id').values('client_id','label','date')[:9])
        clipped = len(workouts)>8
        for w in workouts[:8]:
            links = list(WorkoutExerciseRecord.objects.filter(owner=snapshot_owner, workout_client_id=w['client_id']).order_by('position','client_id').values('client_id','exercise_client_id')[:129])
            clipped |= len(links)>128
            link_map = {x['client_id']:x['exercise_client_id'] for x in links[:128]}
            set_query = SetRecord.objects.filter(owner=snapshot_owner,workout_exercise_client_id__in=link_map)
            order = ('client_id',) if set_query.filter(Q(logged_at__isnull=True) | Q(logged_at='')).exists() else ('logged_at','client_id')
            sets = list(set_query.order_by(*order).values('client_id','workout_exercise_client_id','load_lb','reps','assisted','logged_at')[:13])
            clipped |= len(sets)>12
            exercises = {e['client_id']:e for e in ExerciseRecord.objects.filter(owner=snapshot_owner,client_id__in=set(link_map.values())).values('client_id','name','exercise_type')[:128]}
            for s in sets[:12]:
                e = exercises.get(link_map[s['workout_exercise_client_id']])
                if not e or e['exercise_type'] not in ('barbell','dumbbell','machine','bodyweight','duration'): continue
                performed.append(dict(id=_text(s['client_id'],128), exerciseId=_text(e['client_id'],128), exerciseName=_text(e['name'],120), exerciseType=e['exercise_type'], workoutId=_text(w['client_id'],128), workoutLabel=_text(w['label'],80), date=w['date'], loadLb=_text(s['load_lb'],40) if s['load_lb'] is not None else None, reps=s['reps'], assisted=s['assisted'], loggedAt=_text(s['logged_at'],40) or None, ended=True))
        preference_text = ''
        for pref in profile['preferences'] or []:
            exercise = ExerciseRecord.objects.filter(owner=snapshot_owner, client_id=pref['exerciseId']).values('name').first()
            if exercise:
                preference_text += f" Preference {pref['stance']}: {_text(exercise['name'],120)}."
    context = run_context(dict(asOf=now.isoformat(), timeZone=time_zone, profile=profile, performedSets=performed, plannedSets=[], activeWorkout=None))
    if clipped:
        context['truncation']['truncated'] = True
        context['truncation']['reasons'].append('Server history bounds applied; totals use included sets only.')
    evidence = [{'id':'profile','text':f"Saved profile: goal {profile['goal'] or 'unknown'}; experience {profile['experience'] or 'unknown'}; days {profile['trainingDays'] or 'unknown'}; session minutes {profile['sessionMinutes'] or 'unknown'}."}]
    evidence[0]['text'] = (evidence[0]['text'] + preference_text)[:1500]
    included = set(context['includedSetIds'])
    by_id = {s['id']:s for s in performed}
    recent_groups = set()
    for session in context['recentSessions']:
        evidence.append({'id':'workout:'+session['workoutId'], 'text':f"Completed logged workout on {session['date']}; {len(session['setIds'])} included sets. Date-only chronology."})
    for sid in context['includedSetIds']:
        s = by_id[sid]
        group = GROUPS.get(s['exerciseName'].casefold())
        overlap = f'primary {group[1]}; secondary {group[2]}' if group else 'muscle involvement unknown for this custom or unrecognized name'
        evidence.append({'id':'set:'+sid,'text':f"{s['date']}: {s['exerciseName']}; {overlap}; performed set recorded, not a readiness measure."[:300]})
        if group and s['date'] >= str(local_date-timedelta(days=2)): recent_groups.add(group[0])
    uncertainties = ['Missing logs do not prove rest or absence of training.', 'Unsynced phone history is unknown to the server.', 'Pain, soreness, energy and available time are unknown unless supplied in this check-in.']
    if sync.get('pending') or sync.get('conflicts') or sync.get('cursor') != cursor: uncertainties.append('Phone sync is incomplete or differs from this server snapshot.')
    if len(context['recentSessions'])<2: uncertainties.append('Completed history is sparse; ask before prescribing a training focus.')
    if not context['recentSessions'] or context['recentSessions'][0]['date'] <= str(local_date-timedelta(days=7)): uncertainties.append('Completed history is stale (at least seven days) or absent.')
    if any(GROUPS.get(s['exerciseName'].casefold()) is None for s in performed if s['id'] in included): uncertainties.append('Some exercise muscle groups are unknown; overlap cannot be fully assessed.')
    for gap in context['gaps']:
        if len(uncertainties) < 12 and gap not in uncertainties:
            uncertainties.append(gap)
    allowed = ['light','clarify']
    stale = not context['recentSessions'] or context['recentSessions'][0]['date'] <= str(local_date-timedelta(days=7))
    unknown_groups = any(GROUPS.get(s['exerciseName'].casefold()) is None for s in performed if s['id'] in included)
    if len(context['recentSessions'])>=2 and not stale and not unknown_groups:
        allowed += ['upper','lower','full_body'] if not recent_groups else (['upper'] if recent_groups == {'lower'} else ['lower'] if recent_groups == {'upper'} else [])
    meaningful = {'cursor':cursor,'localDate':str(local_date),'timeZone':time_zone,'context':{k:v for k,v in context.items() if k!='asOf'},'evidence':evidence,'allowedFocus':allowed,'uncertainties':uncertainties}
    revision = hashlib.sha256(json.dumps(meaningful,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'snapshot':{'cursor':cursor,'revision':revision,'asOf':now.isoformat(),'timeZone':time_zone,'localDate':str(local_date)},'context':context,'evidence':evidence,'allowedFocus':allowed,'uncertainties':uncertainties}
