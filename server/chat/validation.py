"""Fail-closed chat boundary; model output has no authority outside this schema."""
import re
from decimal import Decimal


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('unexpected fields')


def string(value, maximum, minimum=1):
    if not isinstance(value, str) or not minimum <= len(value) <= maximum or (minimum and not value.strip()):
        raise ValueError('invalid text')


def validate_request(data):
    required = {'note','consent','contextRevision','workout','exercises'}
    if not isinstance(data, dict) or not required <= set(data) or set(data) - required - {'aiPolicyId'}:
        raise ValueError('unexpected request fields')
    string(data['note'],2000)
    string(data['contextRevision'],256)
    if type(data['consent']) is not bool:
        raise ValueError('invalid consent')
    if 'aiPolicyId' in data:
        string(data['aiPolicyId'],128)
    workout=data['workout']
    if workout is not None:
        exact(workout,{'id','label','ended'})
        string(workout['id'],128)
        string(workout['label'],80,0)
        if workout['ended'] is not False:
            raise ValueError('workout is not active')
    exercises=data['exercises']
    if not isinstance(exercises,list) or len(exercises)>500:
        raise ValueError('invalid catalog')
    ids=set()
    for exercise in exercises:
        exact(exercise,{'id','name','type'})
        string(exercise['id'],128)
        string(exercise['name'],120)
        if exercise['id'] in ids or exercise['type'] not in ('barbell','dumbbell','machine','bodyweight','duration'):
            raise ValueError('invalid exercise')
        ids.add(exercise['id'])
    return data


def validate_response(data,payload=None):
    if not isinstance(data,dict) or type(data.get('version')) is not int or data['version']!=1:
        raise ValueError('invalid response version')
    string(data.get('contextRevision'),256)
    if payload is not None and data['contextRevision']!=payload['contextRevision']:
        raise ValueError('stale revision')
    if data.get('status')=='clarify':
        exact(data,{'version','status','contextRevision','question','reason'})
        string(data['question'],500)
        if data['reason'] not in ('workout','exercise','reps','intent'):
            raise ValueError('invalid clarification')
        return data
    exact(data,{'version','status','contextRevision','proposal'})
    if data['status']!='proposal' or not isinstance(data['proposal'],dict):
        raise ValueError('invalid proposal')
    p=data['proposal']; kind=p.get('kind')
    if kind=='start_workout':
        exact(p,{'kind','label'}); string(p['label'],80)
        if payload is not None and payload['workout'] is not None:
            raise ValueError('workout already open')
    elif kind=='resume_workout':
        exact(p,{'kind','workoutId','label'}); string(p['workoutId'],128); string(p['label'],80)
        if payload is not None and (not payload['workout'] or p['workoutId']!=payload['workout']['id'] or p['label']!=payload['workout']['label']):
            raise ValueError('unknown workout')
    elif kind=='log_set':
        exact(p,{'kind','workoutId','exerciseId','exerciseName','loadLb','reps','assisted'})
        string(p['workoutId'],128); string(p['exerciseId'],128); string(p['exerciseName'],120)
        if not isinstance(p['loadLb'],str) or not re.fullmatch(r'\d{1,6}(?:\.\d{1,2})?',p['loadLb']) or not 0<Decimal(p['loadLb'])<=100000:
            raise ValueError('invalid load')
        if type(p['reps']) is not int or not 1<=p['reps']<=1000 or type(p['assisted']) is not bool:
            raise ValueError('invalid set')
        if payload is not None and (not payload['workout'] or p['workoutId']!=payload['workout']['id'] or not any(e['id']==p['exerciseId'] and e['name']==p['exerciseName'] for e in payload['exercises'])):
            raise ValueError('unknown workout or exercise')
    else:
        raise ValueError('unknown action')
    return data
