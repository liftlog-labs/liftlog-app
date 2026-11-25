#!/usr/bin/env bash
set -euo pipefail

# Run in a clean release checkout with local Node and Python dependencies.
# Point LIFTLOG_TEST_POSTGRES_URL at a newly created disposable local database.
sha=$(git rev-parse HEAD)
test -z "$(git status --porcelain)"
: "${LIFTLOG_TEST_POSTGRES_URL:?Set the disposable localhost PostgreSQL DSN}"
: "${LIFTLOG_SCAN_OUTPUT:?Set an absolute output directory outside the checkout}"
mkdir -p "$LIFTLOG_SCAN_OUTPUT"

export CHAT_PROVIDER=fake
export PYTHONDONTWRITEBYTECODE=1
CI=1 ./node_modules/.bin/expo lint --no-cache
npm run typecheck
read -r -a app_tests <<< "$(node -p "require('./package.json').scripts.test.replace(/^tsx --test /, '')")"
node --import tsx --test "${app_tests[@]}"
(
  cd server
  .venv/bin/python -m pytest -q
  .venv/bin/python -m pytest --ds=config.postgres_test_settings -q
  .venv/bin/python manage.py makemigrations --check --dry-run
)
node --import tsx scripts/test-mobile-sync.mts

container_engine=${LIFTLOG_CONTAINER_ENGINE:-podman}
image="liftlog-pilot:$sha"
"$container_engine" build --platform linux/amd64 -f deploy/Dockerfile -t "$image" .
"$container_engine" image inspect --format '{{.Id}}' "$image" > "$LIFTLOG_SCAN_OUTPUT/$sha-image-id.txt"
"$container_engine" run --rm --platform linux/amd64 --network none -e DJANGO_SETTINGS_MODULE=config.settings --entrypoint sh "$image" -ec '
  test "$(id -un)" = liftlog
  test "$(id -u)" -ne 0
  for dir in /bin /sbin /usr/bin /usr/sbin; do
    for name in mount umount; do
      test ! -e "$dir/$name" && test ! -L "$dir/$name"
    done
  done
  test -z "$(find /usr/lib /lib -name "libmount.so*" -print)"
  cd /app/server
  python -c "import django; django.setup(); from chat.coaching_context import run_context; run_context(dict(asOf=\"2026-01-01T00:00:00Z\",timeZone=\"UTC\",profile=dict(goal=None,experience=None,trainingDays=None,sessionMinutes=None,equipment=None,preferences=None,updatedAt=None,revision=0),performedSets=[],plannedSets=[],activeWorkout=None))"
'
image_tar=$(mktemp "${TMPDIR:-/tmp}/liftlog-image.XXXXXX")
trap 'rm -f "$image_tar"' EXIT
"$container_engine" save --format docker-archive -o "$image_tar" "$image"
trivy image --download-db-only
trivy image --input "$image_tar" --skip-db-update --scanners vuln \
  --format json --output "$LIFTLOG_SCAN_OUTPUT/$sha-full.json"
trivy image --input "$image_tar" --skip-db-update --scanners vuln \
  --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 \
  --format json --output "$LIFTLOG_SCAN_OUTPUT/$sha-fixable.json"
