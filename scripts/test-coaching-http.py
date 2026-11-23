"""Two real loopback workers, one disposable DB, synthetic accounts, fake inference."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parents[1]
SERVER=ROOT/'server'
with tempfile.TemporaryDirectory(prefix='liftlog-coaching-http-') as directory:
    database=str(Path(directory)/'synthetic.sqlite3')
    env={**os.environ,'DJANGO_SETTINGS_MODULE':'config.sync_test_settings','LIFTLOG_TEST_DATABASE':database,'DJANGO_DEBUG':'0','LIFTLOG_LOCAL_DEV_OPEN':'0','CHAT_PROVIDER':'fake','DJANGO_SECRET_KEY':'synthetic-shared-coaching-worker-test-key-only'}
    subprocess.run([sys.executable,'manage.py','migrate','--noinput'],cwd=SERVER,env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    processes=[]
    bases=[]
    def request(base,path,body=None,token=None):
        headers={'Content-Type':'application/json'}
        if token: headers['Authorization']='Bearer '+token
        try: response=urlopen(Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method='POST' if body is not None else 'GET'),timeout=15)
        except HTTPError as error: response=error
        return response.status,json.loads(response.read() or b'{}')
    try:
        for _ in range(2):
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            process=subprocess.Popen([sys.executable,'manage.py','runserver',f'127.0.0.1:{port}','--noreload'],cwd=SERVER,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            processes.append(process);bases.append(f'http://127.0.0.1:{port}')
            for _ in range(100):
                try:
                    with socket.create_connection(('127.0.0.1',port),timeout=.1):break
                except OSError:time.sleep(.05)
        password='Synthetic-Worker-Only-498!'
        accounts=[]
        for name in ('a','b'):
            status,session=request(bases[0],'/api/v1/auth/register',{'email':f'worker-{name}@synthetic.invalid','password':password})
            assert status==201
            token=session['token'];identity=session['account']['accountId']
            status,policy=request(bases[0],'/api/v1/chat/policy',token=token);assert status==200
            grant={key:policy[key] for key in ('providerId','consentVersion')}
            assert request(bases[0],'/api/v1/chat/consent',{**grant,'accepted':True},token)[0]==200
            accounts.append((token,identity,policy,grant))
        token,identity,policy,grant=accounts[0]
        body={'question':'What should I train today?','aiPolicyId':policy['providerId'],'timeZone':'UTC','sync':{'cursor':0,'pending':False,'conflicts':False},'turns':[]}
        def domain():
            with sqlite3.connect(database) as db:
                tables=[row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' ORDER BY name")]
                return {table:db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() for table in tables}
        before=domain()
        for i in range(6):
            status,answer=request(bases[i%2],'/api/v1/chat/coach',body,token)
            assert status==200 and answer['accountId']==identity and answer['kind']=='coaching'
        assert request(bases[1],'/api/v1/chat/coach',body,token)[0]==429
        other,other_id,other_policy,_=accounts[1]
        status,answer=request(bases[1],'/api/v1/chat/coach',{**body,'aiPolicyId':other_policy['providerId']},other)
        assert status==200 and answer['accountId']==other_id and other_id!=identity
        assert request(bases[1],'/api/v1/chat/coach',{**body,'accountId':identity},other)[0]==400
        assert domain()==before
        assert request(bases[0],'/api/v1/chat/consent',{**grant,'accepted':False},token)[0]==200
        assert request(bases[1],'/api/v1/chat/coach',body,token)[0]==403
        assert request(bases[0],'/api/v1/account/delete',{'confirm':True,'password':password},token)[0]==200
        assert request(bases[1],'/api/v1/chat/coach',body,token)[0]==401
        print('PASS two-worker coaching HTTP: shared six-request budget, owned identities, no record mutation, forged selector400, revocation403, deleted token401. Fake inference only.')
    finally:
        for process in processes:
            process.terminate();process.wait(timeout=10)
