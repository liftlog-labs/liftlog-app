"""Public disclosure derived from server configuration, never from credentials."""
import hashlib
import json
import os
from urllib.parse import urlsplit
from chat.providers import ProviderError

CONSENT_VERSION='2026-11-16'


def provider_config():
    choice=os.environ.get('CHAT_PROVIDER','').strip().lower()
    if not choice:
        choice='gemini' if os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY') else 'fake'
    defaults={
        'fake':('Local deterministic parser','local','fake'),
        'openai':('OpenAI','https://api.openai.com/v1','gpt-4o-mini'),
        'groq':('Groq','https://api.groq.com/openai/v1','openai/gpt-oss-120b'),
        'gemini':('Google Gemini','https://generativelanguage.googleapis.com/v1beta','gemini-3.5-flash-lite'),
    }
    if choice not in defaults and choice!='openai-compatible':
        raise ProviderError('Unsupported provider configuration')
    if choice=='openai-compatible':
        name=os.environ.get('MODEL_PROVIDER_NAME','').strip()
        destination=os.environ.get('MODEL_BASE_URL','').rstrip('/')
        if not name or len(name)>120:
            raise ProviderError('Custom provider identity is required')
        model=os.environ.get('MODEL_NAME','').strip()
    else:
        name,destination,model=defaults[choice]
        if choice!='fake':
            destination=os.environ.get('MODEL_BASE_URL',destination).rstrip('/')
            model=os.environ.get('MODEL_NAME',model)
    if choice!='fake':
        try:
            parsed=urlsplit(destination)
            port=parsed.port
        except ValueError as error:
            raise ProviderError('Invalid provider destination') from error
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or port not in (None,443):
            raise ProviderError('Invalid provider destination')
        if choice!='openai-compatible' and destination!=defaults[choice][1]:
            raise ProviderError('Use explicit custom provider configuration')
        if not model or len(model)>160 or any(c in model for c in '?&#'):
            raise ProviderError('Invalid model configuration')
    fingerprint=hashlib.sha256(json.dumps([choice,name,destination,model,CONSENT_VERSION]).encode()).hexdigest()
    return {'choice':choice,'providerName':name,'destination':destination,'model':model,'providerId':fingerprint}


def public_policy(user):
    from accounts.models import AIConsent
    config=provider_config()
    external=config['choice']!='fake'
    return {
        'providerId':config['providerId'],'providerName':config['providerName'],
        'consentVersion':CONSENT_VERSION,'external':external,
        'fields':['note','contextRevision','workout (id, label, ended)','exercise catalog (id, name, type)', 'read-only coaching training profile', 'bounded completed workout history and calculated facts', 'history gaps, daily check-in and coaching question', 'up to four recent coaching turns'],
        'retentionNotice':('The configured AI provider receives these fields. Provider retention and abuse-monitoring rules apply; zero retention is not guaranteed. Revoking stops future sharing and does not erase prior provider data.' if external else 'Parsed on this server without an external AI provider.'),
        'accepted': AIConsent.objects.filter(user=user,provider_id=config['providerId'],consent_version=CONSENT_VERSION,accepted=True).exists(),
    }
