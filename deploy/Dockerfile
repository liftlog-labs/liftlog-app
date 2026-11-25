FROM docker.io/library/node:24-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4 AS node
FROM docker.io/library/python:3.13-slim-trixie@sha256:7249d5587b78209a006dc4a3b5340678f84ea729239193aa559962cd8c1fce50
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DJANGO_SETTINGS_MODULE=config.cloud_settings
COPY deploy/requirements.lock /tmp/requirements.lock
RUN apt-get update \
 && apt-get install -y --no-install-recommends libzstd1=1.5.7+dfsg-1+deb13u1 \
 && apt-get clean \
 && pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock \
 && python -m pip uninstall -y pip \
 && python -c 'import ensurepip, pathlib, shutil; shutil.rmtree(pathlib.Path(ensurepip.__file__).parent / "_bundled")' \
 && groupadd --system liftlog \
 && useradd --system --gid liftlog liftlog \
 && unlink /usr/bin/mount \
 && unlink /usr/bin/umount \
 && unlink /usr/lib/x86_64-linux-gnu/libmount.so.1 \
 && unlink /usr/lib/x86_64-linux-gnu/libmount.so.1.1.0
COPY server/ server/
COPY scripts/personal-context.mjs scripts/
COPY src/modules/personalContextCore.ts src/modules/
WORKDIR /app/server
USER liftlog
CMD ["gunicorn", "--workers", "2", "--threads", "2", "--timeout", "45", "--limit-request-line", "4094", "config.wsgi:application"]
