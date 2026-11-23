FROM docker.io/library/node:24-bookworm-slim@sha256:0e2646ab57e77b7a384a0cb59b6815b182c77e1f9c3ba36bd8435bd9c4e6680e AS node
FROM docker.io/library/python:3.13-slim-bookworm@sha256:f3dac913ab53b78c64f26d5518fcd7043d5a1a46522d6a493b598c3ed12f62a6
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DJANGO_SETTINGS_MODULE=config.cloud_settings
COPY deploy/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock \
 && groupadd --system liftlog \
 && useradd --system --gid liftlog liftlog
COPY server/ server/
COPY scripts/personal-context.mjs scripts/
COPY src/modules/personalContextCore.ts src/modules/
WORKDIR /app/server
USER liftlog
CMD ["gunicorn", "--workers", "2", "--threads", "2", "--timeout", "45", "--limit-request-line", "4094", "config.wsgi:application"]
