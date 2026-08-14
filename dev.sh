#!/usr/bin/env bash
# Start all services for local development.
# Redis runs in Docker; Mongo runs natively (start with: brew services start mongodb-community).
# Everything else runs natively with hot reload.
#
# Usage:
#   ./dev.sh          start everything
#   ./dev.sh --no-infra   skip docker infra (if you already have redis running)

set -eo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

SKIP_INFRA=false
for arg in "$@"; do
  case "$arg" in
    --no-infra) SKIP_INFRA=true ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

if [ "$SKIP_INFRA" = false ]; then
  echo "==> starting infra (redis) in docker"
  docker compose up -d redis
fi

if ! pgrep -x mongod >/dev/null 2>&1; then
  echo "==> WARNING: mongod does not appear to be running."
  echo "    start it with: brew services start mongodb-community"
fi

PIDS=()

cleanup() {
  echo ""
  echo "==> shutting down services"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

start() {
  local name="$1"
  local dir="$2"
  local script="$3"
  echo "==> [$name] starting (cd $dir && npm run $script)"
  ( cd "$dir" && npm run "$script" 2>&1 | sed -u "s/^/[$name] /" ) &
  PIDS+=($!)
}

start ml         ml              dev
start backend    backend         dev
start cf-api     cloud-function  dev
start cf-worker  cloud-function  worker
start frontend   frontend        start

echo ""
echo "==> all services launched. Ctrl+C to stop."
echo ""

wait
