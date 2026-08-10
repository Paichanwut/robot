#!/usr/bin/env bash
# Packs everything needed to resume this bot on another machine: the SQLite
# state (which site/series/chapter has already been scraped) and .env
# (MySQL/R2 credentials). Deliberately leaves out server/data/chrome-profile
# (just browser cache/cookies - regenerates itself), server/data/export
# (old one-off image exports, can be multiple GB), and server/data/backups
# (local safety snapshots, not needed on a fresh machine) - none of them
# affect what the bot thinks it has already scraped.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-bot-state-$(date +%Y%m%d-%H%M%S).tar.gz}"
DATA_DIR="server/data"

if [ ! -f "$DATA_DIR/app.db" ]; then
  echo "error: $DATA_DIR/app.db not found - run this from the robot/ checkout that has been running the bot" >&2
  exit 1
fi

# -wal/-shm hold not-yet-checkpointed writes; grab them if present so an
# export taken while the bot is running doesn't lose the last few writes.
FILES=("$DATA_DIR/app.db")
[ -f "$DATA_DIR/app.db-wal" ] && FILES+=("$DATA_DIR/app.db-wal")
[ -f "$DATA_DIR/app.db-shm" ] && FILES+=("$DATA_DIR/app.db-shm")
[ -f ".env" ] && FILES+=(".env")

tar -czf "$OUT" "${FILES[@]}"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "copy this file to the new machine and run: scripts/import-state.sh $OUT"
