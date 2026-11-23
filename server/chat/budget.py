"""Shared inference request ceilings for external Log and Coach."""
import time

from django.db import OperationalError, transaction
from django.db.models import F

from accounts.models import CoachingRateBucket


def reserve_budget(user_id):
    # Conditional SQL updates are atomic across workers, including SQLite where
    # select_for_update is a no-op. Failure rolls back all windows together.
    now=int(time.time())
    windows=[(f'global:minute:{now//60}',30),(f'user:{user_id}:minute:{now//60}',6),
             (f'global:day:{now//86400}',1000),(f'user:{user_id}:day:{now//86400}',100)]
    try:
        with transaction.atomic():
            for key,limit in windows:
                CoachingRateBucket.objects.get_or_create(key=key)
                if not CoachingRateBucket.objects.filter(key=key,count__lt=limit).update(count=F('count')+1):
                    raise ValueError('budget')
            # Fixed window rows need no transcript and old windows are disposable.
            for cadence, current in (('minute',now//60),('day',now//86400)):
                keys=CoachingRateBucket.objects.filter(key__contains=f':{cadence}:').values_list('key',flat=True)
                old=[key for key in keys if int(key.rsplit(':',1)[1])<current]
                if old: CoachingRateBucket.objects.filter(key__in=old).delete()
        return True
    except (ValueError,OperationalError):
        return False
