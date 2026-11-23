"""Authenticated, account-scoped read-only coaching operation."""
import re
from django.contrib.auth import get_user_model
from django.db import OperationalError, transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from accounts.models import AccountProfile
from chat.budget import reserve_budget
from records.models import AccountSyncState
from chat.policy import public_policy
from chat.providers import ProviderError
from chat.validation import exact, string
from chat.coaching import check_in, generate_coaching, validate_output
from chat.coaching_context import CoachingContextError, build_coaching_packet


def validate_input(data):
    exact(data,{'question','aiPolicyId','timeZone','sync','turns'})
    string(data['question'],1000)
    string(data['timeZone'],80)
    if not isinstance(data['aiPolicyId'],str) or not re.fullmatch('[a-f0-9]{64}',data['aiPolicyId']): raise ValueError('policy')
    exact(data['sync'],{'cursor','pending','conflicts'})
    if type(data['sync']['cursor']) is not int or not 0<=data['sync']['cursor']<=9007199254740991: raise ValueError('cursor')
    if any(type(data['sync'][key]) is not bool for key in ('pending','conflicts')): raise ValueError('sync')
    if not isinstance(data['turns'],list) or len(data['turns'])>4: raise ValueError('turns')
    for turn in data['turns']:
        exact(turn,{'role','text'})
        if turn['role'] not in ('user','assistant'): raise ValueError('role')
        string(turn['text'],1500)


def consent_current(user,policy_id):
    policy=public_policy(user)
    return policy['accepted'] and policy['providerId']==policy_id


class CoachingView(APIView):
    permission_classes=[IsAuthenticated]

    def post(self,request):
        try: validate_input(request.data)
        except (ValueError,TypeError,KeyError): return Response({'code':'INVALID_REQUEST'},status=400)
        try:
            if not consent_current(request.user,request.data['aiPolicyId']): return Response({'code':'AI_CONSENT_REQUIRED'},status=403)
            from chat.policy import provider_config
            if provider_config()['choice'] not in ('groq','fake'): raise ProviderError('Coaching unavailable')
            if not reserve_budget(request.user.pk): return Response({'code':'RATE_LIMITED'},status=429)
            packet=build_coaching_packet(request.user,request.data['timeZone'],request.data['sync'])
            packet['checkIn']=check_in(request.data['question'],request.data['turns'])
            if packet['checkIn'].get('sorenessReported') or packet['checkIn'].get('painReported'):
                packet['allowedFocus']=[focus for focus in packet['allowedFocus'] if focus in ('light','clarify')]
            if not get_user_model().objects.filter(pk=request.user.pk).exists(): return Response({'code':'ACCOUNT_GONE'},status=410)
            if not consent_current(request.user,request.data['aiPolicyId']): return Response({'code':'AI_CONSENT_REQUIRED'},status=403)
            result=validate_output(generate_coaching(packet,request.data['question'],request.data['turns']),packet)
            # Re-evaluate identity, consent and snapshot after the network call.
            # Serialize with account/sync writers until the response is assembled.
            with transaction.atomic():
                user=get_user_model().objects.select_for_update().filter(pk=request.user.pk).first()
                if user is None: return Response({'code':'ACCOUNT_GONE'},status=410)
                if not consent_current(user,request.data['aiPolicyId']): return Response({'code':'AI_CONSENT_REQUIRED'},status=403)
                state=AccountSyncState.objects.select_for_update().filter(owner=user).first()
                if (state.cursor if state else 0)!=packet['snapshot']['cursor']: return Response({'code':'STALE_CONTEXT'},status=409)
                profile=AccountProfile.objects.get(user=user)
                # Always retain canonical profile/recent fact cards; the model only
                # selects supplementary set references, never edits card text.
                evidence=[item for item in packet['evidence'] if item['id'] in result['evidenceIds'] or item['id']=='profile' or item['id'].startswith('workout:')]
                uncertainties=list(dict.fromkeys([*packet['uncertainties'],*result['uncertainties']]))[:12]
                return Response({'version':1,'kind':'coaching','accountId':str(profile.public_id),'snapshot':packet['snapshot'],
                                 'answer':result['answer'],'focus':result['focus'],'evidence':evidence,'uncertainties':uncertainties,'questions':result['questions']})
        except (CoachingContextError,ProviderError,ValueError,TypeError,KeyError,OperationalError):
            return Response({'code':'UNAVAILABLE'},status=503)
