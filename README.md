# Liftlog

Liftlog is an Expo SDK 58 strength-training log with an optional Django API for account sync, Log chat and read-only Coach. Manual logging uses the phone’s SQLite database and works without the API.

## Local development

Use Node 22.18 or newer, npm and Python 3.11 or newer. Run `npm ci` and `npm start` for Expo. For the API:

```bash
cd server
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python manage.py migrate
CHAT_PROVIDER=fake .venv/bin/python manage.py runserver 127.0.0.1:8000
```

Create a synthetic test account and review Connection permissions before using sync or AI. Coach runs the Node bridge in `scripts/personal-context.mjs`. Provider keys belong in server-side environment configuration. Configuration and generated native folders use Expo prebuild.

## Checks

```bash
npm test
npm run lint
npm run typecheck
(cd server && CHAT_PROVIDER=fake .venv/bin/pytest -q)
node_modules/.bin/tsx scripts/test-mobile-sync.mts
```

Read the [manual logging checklist](docs/MANUAL_WORKOUT_LOGGING.md), [account and sync contract](docs/ACCOUNT_SYNC_DESIGN.md), [workout scope](docs/WORKOUT_EXPERIENCE_SCOPE.md) and [source publication rules](docs/CLOUD_PILOT_PUBLICATION.md).
