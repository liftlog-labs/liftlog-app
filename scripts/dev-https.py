#!/usr/bin/env python3
"""Private, disposable HTTPS development listener (not a production server)."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server
from socketserver import ThreadingMixIn

CA_DIR = Path.home() / '.local/share/liftlog-dev-https'

def private_ip(value):
    ip = ipaddress.IPv4Address(value)
    if not any(ip in ipaddress.ip_network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise argparse.ArgumentTypeError('LAN address must be private RFC1918 IPv4')
    return str(ip)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['setup', 'serve', 'stop', 'expire-sessions'])
    parser.add_argument('--hostname')
    parser.add_argument('--lan-ip', type=private_ip)
    parser.add_argument('--port', type=int, default=8443)
    args = parser.parse_args()
    if args.command in ('stop','expire-sessions'):
        metadata_path=CA_DIR/'active-run.json'
        if not metadata_path.is_file():
            parser.error('No active isolated HTTPS server is recorded')
        active=json.loads(metadata_path.read_text())
        root=Path(active['runDir']).resolve()
        database=Path(active['database']).resolve()
        if database.parent!=root or not root.is_relative_to(Path(tempfile.gettempdir()).resolve()) or not (root/'disposable-https-run').is_file():
            parser.error('Refusing a database outside a marked disposable run')
        if args.command=='expire-sessions':
            with sqlite3.connect(database) as db:
                db.execute("UPDATE accounts_authsession SET expires_at='2000-01-01T00:00:00+00:00'")
            print('Expired sessions in the disposable HTTPS test database only.')
            return
        pid=int(active['pid'])
        command=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True)
        if 'scripts/dev-https.py serve' not in command:
            parser.error('Recorded process is not this development listener; no signal sent')
        os.kill(pid,signal.SIGINT)
        print('Requested shutdown of the isolated HTTPS development server.')
        return
    if not args.hostname:
        parser.error('--hostname is required for setup and serve')
    if not re.fullmatch(r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+local', args.hostname):
        parser.error('hostname must be a .local DNS name')
    if not 1<=args.port<=65535:
        parser.error('port must be between 1 and 65535')
    hosts = [args.hostname, 'localhost', '127.0.0.1'] + ([args.lan_ip] if args.lan_ip else [])
    metadata = {'hosts': hosts}
    os.umask(0o077)
    if args.command == 'setup':
        if CA_DIR.exists():
            parser.error(f'{CA_DIR} already exists; preserve or move it explicitly before new setup')
        CA_DIR.mkdir(parents=True, mode=0o700)
        def openssl(*values):
            subprocess.run(['openssl', *values], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        openssl('req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', str(CA_DIR/'ca.key'), '-out', str(CA_DIR/'ca.pem'), '-days', '30', '-subj', '/CN=LiftLog private development CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
        openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(CA_DIR/'server.key'), '-out', str(CA_DIR/'server.csr'), '-subj', f'/CN={args.hostname}')
        sans = [f'DNS:{args.hostname}', 'DNS:localhost', 'IP:127.0.0.1'] + ([f'IP:{args.lan_ip}'] if args.lan_ip else [])
        (CA_DIR/'extensions.cnf').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName='+','.join(sans)+'\n')
        openssl('x509', '-req', '-in', str(CA_DIR/'server.csr'), '-CA', str(CA_DIR/'ca.pem'), '-CAkey', str(CA_DIR/'ca.key'), '-CAcreateserial', '-out', str(CA_DIR/'server.pem'), '-days', '7', '-extfile', str(CA_DIR/'extensions.cnf'))
        openssl('x509','-in',str(CA_DIR/'ca.pem'),'-outform','DER','-out',str(CA_DIR/'ca.cer'))
        (CA_DIR/'metadata.json').write_text(json.dumps(metadata))
        print(f'Created private development CA: {CA_DIR / "ca.pem"}; no system trust changed.')
        return
    if json.loads((CA_DIR/'metadata.json').read_text()) != metadata:
        parser.error('Certificate host configuration differs; use the setup hostname and LAN address')
    run = Path(tempfile.mkdtemp(prefix='liftlog-https-'))
    (run/'disposable-https-run').touch()
    os.environ.update(DJANGO_SETTINGS_MODULE='config.dev_https_settings', LIFTLOG_TEST_DATABASE=str(run/'test.sqlite3'), LIFTLOG_HTTPS_RUN_DIR=str(run), LIFTLOG_HTTPS_HOSTS=','.join(hosts), LIFTLOG_HTTPS_PORT=str(args.port), DJANGO_SECRET_KEY=secrets.token_urlsafe(48), DJANGO_DEBUG='0', LIFTLOG_LOCAL_DEV_OPEN='0', CHAT_PROVIDER='fake')
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent/'server'))
    import django
    django.setup()
    from django.core.management import call_command
    from django.core.wsgi import get_wsgi_application
    call_command('migrate', verbosity=0)
    application = get_wsgi_application()
    active={'pid':os.getpid(),'runDir':str(run),'database':str(run/'test.sqlite3'),'url':f'https://{args.hostname}:{args.port}'}
    class Server(ThreadingMixIn, WSGIServer):
        daemon_threads = True
    class Handler(WSGIRequestHandler):
        def log_message(self, *args):
            pass
        def get_environ(self):
            environ = super().get_environ()
            environ['wsgi.url_scheme'] = 'https'
            environ['HTTPS'] = 'on'
            return environ
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(CA_DIR/'server.pem', CA_DIR/'server.key')
    servers = []
    try:
        for address in ['127.0.0.1'] + ([args.lan_ip] if args.lan_ip else []):
            server = make_server(address, args.port, application, Server, Handler)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            servers.append(server)
            threading.Thread(target=server.serve_forever, daemon=True).start()
        (CA_DIR/'active-run.json').write_text(json.dumps(active))
        print(f'Development HTTPS ready: https://{args.hostname}:{args.port} (fake provider, disposable database)', flush=True)
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        from django.db import connections
        connections.close_all()
        try:
            if json.loads((CA_DIR/'active-run.json').read_text()).get('pid')==os.getpid():
                (CA_DIR/'active-run.json').unlink()
        except (FileNotFoundError,ValueError):
            pass

if __name__ == '__main__':
    main()
