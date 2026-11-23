import pytest
from unittest.mock import patch
from chat.tests.test_interpret import payload
from chat.interpret import parse_model_content
import json

@pytest.mark.parametrize('proposal', [None, {'actions':[{'kind':'start_workout','label':'Leg Day'}]}, {'kind':'execute_sql'}, {'kind':'start_workout','label':'x','extra':True}])
def test_rejects_invalid_model_proposals(proposal):
    with pytest.raises(ValueError):
        parse_model_content(json.dumps({'version':1,'status':'proposal','contextRevision':'none','proposal':proposal}))

@pytest.mark.django_db
def test_external_grant_revoke_and_provider_change(auth_client, monkeypatch):
    monkeypatch.setenv('CHAT_PROVIDER','openai')
    monkeypatch.delenv('MODEL_BASE_URL',raising=False)
    policy = auth_client.get('/api/v1/chat/policy')
    assert policy.status_code == 200
    policy = policy.json()
    assert policy['external'] and not policy['accepted']
    data = payload("It's leg day today")
    data['aiPolicyId'] = policy['providerId']
    with patch('chat.views.get_provider') as provider:
        assert auth_client.post('/api/v1/chat/interpret',data,format='json').status_code == 403
        provider.assert_not_called()
    consent = {k:policy[k] for k in ('providerId','consentVersion')}
    assert auth_client.post('/api/v1/chat/consent',{**consent,'accepted':True},format='json').status_code == 200
    assert auth_client.get('/api/v1/chat/policy').json()['accepted']
    with patch('chat.views.get_provider') as factory:
        factory.return_value.name='openai'
        factory.return_value.interpret.return_value={'version':1,'status':'proposal','contextRevision':'none','proposal':{'kind':'start_workout','label':'Leg Day'}}
        assert auth_client.post('/api/v1/chat/interpret',data,format='json').status_code == 200
        factory.reset_mock()
        assert auth_client.post('/api/v1/chat/interpret',{**data,'history':[]},format='json').status_code == 400
        factory.assert_not_called()
    assert auth_client.post('/api/v1/chat/consent',{**consent,'accepted':False},format='json').status_code == 200
    with patch('chat.views.get_provider') as factory:
        assert auth_client.post('/api/v1/chat/interpret',data,format='json').status_code == 403
        factory.assert_not_called()
    assert auth_client.post('/api/v1/account/consent',{'cloudSync':'2026-11-05'},format='json').status_code == 200
    from records.tests.test_sync import exercise, push
    identity = auth_client.get('/api/v1/account').json()['accountId']
    assert push(auth_client, identity, [exercise()]).status_code == 200
    assert len(auth_client.get('/api/v1/sync/pull?cursor=0').json()['changes']) == 1
    monkeypatch.setenv('MODEL_NAME','changed-model')
    assert auth_client.post('/api/v1/chat/consent',{**consent,'accepted':True},format='json').status_code == 403

@pytest.mark.django_db
@pytest.mark.parametrize('change',[
    {'note':''},{'note':'x'*2001},{'contextRevision':'x'*257},
    {'workout':{'id':'w','label':'x','ended':True}},
    {'exercises':[{'id':'x','name':'x','type':'machine','history':[]}]},
    {'exercises':[{'id':'x','name':'x','type':'machine'}]*2},
    {'exercises':[{'id':str(i),'name':'x','type':'machine'} for i in range(501)]},
    {'consent':1},{'owner':'other'},
])
def test_bad_input_never_reaches_provider(auth_client,monkeypatch,change):
    monkeypatch.setenv('CHAT_PROVIDER','fake')
    with patch('chat.views.get_provider') as factory:
        assert auth_client.post('/api/v1/chat/interpret',{**payload('leg press'),**change},format='json').status_code==400
        factory.assert_not_called()

@pytest.mark.parametrize('change',[
    {'proposal':None},{'contextRevision':'stale'},
    {'proposal':{'kind':'log_set','workoutId':'w','exerciseId':'unknown','exerciseName':'Leg Press','loadLb':'100','reps':10,'assisted':False}},
    {'proposal':{'kind':'log_set','workoutId':'w','exerciseId':'seed-leg-press','exerciseName':'Leg Press','loadLb':'100.001','reps':10,'assisted':False}},
    {'proposal':{'kind':'log_set','workoutId':'w','exerciseId':'seed-leg-press','exerciseName':'Leg Press','loadLb':'100','reps':True,'assisted':False}},
    {'question':'x'*501},
])
@pytest.mark.django_db
def test_patched_provider_cannot_bypass_response_validation(auth_client,monkeypatch,change):
    monkeypatch.setenv('CHAT_PROVIDER','fake')
    data=payload('leg press 100 x 10',{'id':'w','label':'Leg Day','ended':False})
    result={'version':1,'status':'proposal','contextRevision':data['contextRevision'],'proposal':{'kind':'log_set','workoutId':'w','exerciseId':'seed-leg-press','exerciseName':'Leg Press','loadLb':'100','reps':10,'assisted':False}}
    with patch('chat.views.get_provider') as factory:
        factory.return_value.interpret.return_value={**result,**change}
        assert auth_client.post('/api/v1/chat/interpret',data,format='json').status_code==503

@pytest.mark.django_db
def test_anonymous_cannot_grant_or_send_externally(monkeypatch,settings):
    from rest_framework.test import APIClient
    settings.DEBUG=True
    settings.LIFTLOG_LOCAL_DEV_OPEN=True
    monkeypatch.setenv('CHAT_PROVIDER','openai')
    monkeypatch.delenv('MODEL_BASE_URL',raising=False)
    client=APIClient()
    assert client.get('/api/v1/chat/policy').status_code in (401,403)
    assert client.post('/api/v1/chat/consent',{},format='json').status_code in (401,403)
    with patch('chat.views.get_provider') as factory:
        assert client.post('/api/v1/chat/interpret',payload('leg day'),format='json').status_code==403
        factory.assert_not_called()

@pytest.mark.parametrize('url',['http://api.openai.com/v1','https://example.com/v1','https://api.openai.com/v1?secret=x','https://user:pass@api.openai.com/v1'])
def test_official_provider_destination_restrictions(monkeypatch,url):
    from chat.policy import provider_config
    from chat.providers import ProviderError
    monkeypatch.setenv('CHAT_PROVIDER','openai')
    monkeypatch.setenv('MODEL_BASE_URL',url)
    with pytest.raises(ProviderError):
        provider_config()


def test_transport_bounds_and_redirects(monkeypatch):
    from chat.providers import _post_json,NoRedirect,ProviderError
    class Response:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def read(self,limit):
            assert limit==65537
            return b'x'*limit
    class Opener:
        def open(self,*args,**kwargs): return Response()
    monkeypatch.setattr('urllib.request.build_opener',lambda *args:Opener())
    with pytest.raises(ProviderError): _post_json('https://example.test',{}, {})
    with pytest.raises(ProviderError): NoRedirect().redirect_request(None,None,302,'',{},'https://elsewhere.test')

@pytest.mark.django_db
def test_switching_back_requires_renewed_consent(auth_client,monkeypatch):
    monkeypatch.delenv('MODEL_BASE_URL',raising=False)
    monkeypatch.delenv('MODEL_NAME',raising=False)
    policies={}
    for choice in ('groq','openai'):
        monkeypatch.setenv('CHAT_PROVIDER',choice)
        policy=auth_client.get('/api/v1/chat/policy').json()
        policies[choice]=policy
        assert auth_client.post('/api/v1/chat/consent',{'providerId':policy['providerId'],'consentVersion':policy['consentVersion'],'accepted':True},format='json').status_code==200
    monkeypatch.setenv('CHAT_PROVIDER','groq')
    assert auth_client.get('/api/v1/chat/policy').json()['accepted'] is False
    with patch('chat.views.get_provider') as factory:
        assert auth_client.post('/api/v1/chat/interpret',{**payload('leg day'),'aiPolicyId':policies['groq']['providerId']},format='json').status_code==403
        factory.assert_not_called()
    assert auth_client.post('/api/v1/account/consent',{'cloudSync':'2026-11-05'},format='json').status_code==200
    assert auth_client.get('/api/v1/sync/pull?cursor=0').status_code==200

@pytest.mark.django_db
@pytest.mark.parametrize('change',[{'note':[]},{'contextRevision':{}},{'aiPolicyId':[]},{'exercises':[{'id':[],'name':'x','type':'machine'}]},{'exercises':[{'id':'x','name':'x','type':[]}]}])
def test_unhashable_input_returns_bad_request(auth_client,monkeypatch,change):
    monkeypatch.setenv('CHAT_PROVIDER','fake')
    with patch('chat.views.get_provider') as factory:
        assert auth_client.post('/api/v1/chat/interpret',{**payload('leg day'),**change},format='json').status_code==400
        factory.assert_not_called()

@pytest.mark.django_db
@pytest.mark.parametrize('field',['providerId','consentVersion'])
def test_malformed_consent_fields_return_bad_request(auth_client,monkeypatch,field):
    monkeypatch.setenv('CHAT_PROVIDER','fake')
    data={'providerId':'x','consentVersion':'2026-11-16','accepted':True,field:[]}
    assert auth_client.post('/api/v1/chat/consent',data,format='json').status_code==400
