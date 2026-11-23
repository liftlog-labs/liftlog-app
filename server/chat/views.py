from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import AIConsent
from chat.budget import reserve_budget
from chat.policy import CONSENT_VERSION, public_policy
from chat.providers import ProviderError, get_provider
from chat.validation import exact, string, validate_request, validate_response


class PolicyView(APIView):
    permission_classes=[IsAuthenticated]

    def get(self,request):
        try:
            return Response(public_policy(request.user))
        except ProviderError:
            return Response({'code':'UNAVAILABLE'},status=503)


class AIConsentView(APIView):
    permission_classes=[IsAuthenticated]

    def post(self,request):
        try:
            exact(request.data,{'providerId','consentVersion','accepted'})
            string(request.data['providerId'],128)
            string(request.data['consentVersion'],40)
            if type(request.data['accepted']) is not bool:
                raise ValueError('invalid consent')
            policy=public_policy(request.user)
        except ValueError:
            return Response({'code':'INVALID_REQUEST'},status=400)
        except ProviderError:
            return Response({'code':'UNAVAILABLE'},status=503)
        if request.data['providerId']!=policy['providerId'] or request.data['consentVersion']!=CONSENT_VERSION:
            return Response({'code':'AI_POLICY_CHANGED'},status=403)
        with transaction.atomic():
            # Serialize grants across provider rows for this account.
            get_user_model().objects.select_for_update().get(pk=request.user.pk)
            if request.data['accepted']:
                AIConsent.objects.filter(user=request.user,accepted=True).exclude(provider_id=policy['providerId']).update(accepted=False)
            AIConsent.objects.update_or_create(user=request.user,provider_id=policy['providerId'],defaults={'consent_version':CONSENT_VERSION,'accepted':request.data['accepted']})
        return Response({**policy,'accepted':request.data['accepted']})


class InterpretView(APIView):
    def post(self, request):
        try:
            validate_request(request.data)
        except ValueError:
            return Response({'code':'INVALID_REQUEST'},status=400)
        if request.data['consent'] is not True:
            return Response({'code':'CONSENT_REQUIRED'},status=400)
        try:
            from chat.policy import provider_config
            config=provider_config()
            if config['choice']!='fake':
                if not request.user or not request.user.is_authenticated:
                    return Response({'code':'AI_CONSENT_REQUIRED'},status=403)
                policy=public_policy(request.user)
                if not policy['accepted'] or request.data.get('aiPolicyId')!=policy['providerId']:
                    return Response({'code':'AI_CONSENT_REQUIRED'},status=403)
                if not reserve_budget(request.user.pk):
                    return Response({'code':'RATE_LIMITED'},status=429)
            provider = get_provider()
            result = validate_response(provider.interpret(request.data),request.data)
        except (ProviderError,ValueError,TypeError,KeyError):
            return Response({'code':'UNAVAILABLE'},status=503)
        return Response({**result,'provider':provider.name})
