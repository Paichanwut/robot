#!/usr/bin/env bash
# Restores a bundle made by export-state.sh into this checkout, then builds
# the Docker image so `docker compose run --rm bot ...` picks up right where
# the old machine left off - same series/chapters already marked done, same
# in-progress site crawls, no re-setup needed.
set -euo pipefail
cd "$(dirname "$0")/.."

IN="${1:?usage: scripts/import-state.sh <bot-state-*.tar.gz>}"
DATA_DIR="server/data"

if [ -f "$DATA_DIR/app.db" ]; then
  echo "warning: $DATA_DIR/app.db already exists on this machine." >&2
  read -r -p "Overwrite it with the imported state? [y/N] " reply
  case "$reply" in
    [yY]*) ;;
    *) echo "aborted - nothing changed"; exit 1 ;;
  esac
fi

mkdir -p "$DATA_DIR"
tar -xzf "$IN"
echo "restored $(tar -tzf "$IN" | tr '\n' ' ')"

if command -v docker >/dev/null 2>&1; then
  docker compose build bot
  echo "done - run: docker compose run --rm bot"
else
  echo "docker not found on PATH - build the image manually before running the bot"
fi
