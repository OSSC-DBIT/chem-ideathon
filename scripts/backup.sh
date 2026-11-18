#!/usr/bin/env bash
# Takes a consistent backup of the database and the payment screenshots.
#
#   bash scripts/backup.sh                # into ./backups/ideathon-<date>-<time>
#   bash scripts/backup.sh /mnt/usb/idt   # into a folder you choose
#
# The app is stopped for a few seconds while the files are copied, so that the database is not
# caught in the middle of a write. Visitors see "back in a minute" during that time.
#
# The backup is encrypted, exactly as the data is on the server. It can only be read with the
# DATA_KEY that is in .env right now. Keep that key somewhere other than this server.
set -euo pipefail
cd "$(dirname "$0")/.."

# Docker on Windows (Git Bash) needs Windows style paths for the host side of a copy.
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

DEST="${1:-backups/ideathon-$(date +%F-%H%M%S)}"
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  echo "Refusing to overwrite: $DEST already exists and is not empty." >&2
  exit 1
fi
mkdir -p "$DEST"
DEST_ABS="$(cd "$DEST" && pwd)"

CID="$(docker compose ps -aq app)"
if [ -z "$CID" ]; then
  echo "The app container does not exist. Run this from the project folder after 'docker compose up -d'." >&2
  exit 1
fi

WAS_RUNNING="$(docker inspect -f '{{.State.Running}}' "$CID")"
restart() { [ "$WAS_RUNNING" = "true" ] && docker compose start app >/dev/null 2>&1; }
trap restart EXIT

[ "$WAS_RUNNING" = "true" ] && docker compose stop app >/dev/null 2>&1
MSYS_NO_PATHCONV=1 docker cp "$CID:/data/." "$(hostpath "$DEST_ABS")"

FILES="$(find "$DEST_ABS" -type f | wc -l | tr -d ' ')"
if [ ! -s "$DEST_ABS/ideathon.db" ]; then
  echo "Backup failed: no database was copied." >&2
  exit 1
fi
echo "Backup written to $DEST_ABS ($FILES files)."
echo "It can only be read with the DATA_KEY currently in .env. Move the backup off this server."
