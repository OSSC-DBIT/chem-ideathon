#!/usr/bin/env bash
# Replaces the site's data with a backup made by scripts/backup.sh.
#
#   bash scripts/restore.sh backups/ideathon-2026-11-27-180000
#
# Everything currently on the site (registrations, student list, screenshots) is replaced.
# .env must contain the DATA_KEY that was in use when the backup was taken.
set -euo pipefail
cd "$(dirname "$0")/.."

# Docker on Windows (Git Bash) needs Windows style paths for the host side of a copy.
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

SRC="${1:-}"
if [ -z "$SRC" ] || [ ! -s "$SRC/ideathon.db" ]; then
  echo "Usage: bash scripts/restore.sh <backup folder>   (the folder must contain ideathon.db)" >&2
  exit 1
fi
SRC_ABS="$(cd "$SRC" && pwd)"

CID="$(docker compose ps -aq app)"
if [ -z "$CID" ]; then
  echo "The app container does not exist. Run 'docker compose up -d' once first." >&2
  exit 1
fi

if [ "${2:-}" != "--yes" ]; then
  echo "This REPLACES all current data on the site with the backup in:"
  echo "  $SRC_ABS"
  read -r -p "Type 'restore' to continue: " answer
  [ "$answer" = "restore" ] || { echo "Cancelled. Nothing was changed."; exit 1; }
fi

docker compose stop app >/dev/null 2>&1

# A helper container empties the data volume, copies the backup in, and hands the files to the
# unprivileged user the app runs as (uid 1000). Without that last step the app could not write.
MSYS_NO_PATHCONV=1 docker run --rm --volumes-from "$CID" alpine sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; mkdir -p /data/uploads'
MSYS_NO_PATHCONV=1 docker cp "$(hostpath "$SRC_ABS")/." "$CID:/data/"
MSYS_NO_PATHCONV=1 docker run --rm --volumes-from "$CID" alpine sh -c 'chown -R 1000:1000 /data && chmod 700 /data'

docker compose start app >/dev/null 2>&1
echo "Restored. Waiting for the app to come up..."
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null)" = "healthy" ]; then
    echo "The site is running on the restored data."
    exit 0
  fi
  sleep 2
done
echo "The app did not become healthy. Most likely DATA_KEY in .env is not the key this backup was made with." >&2
echo "Check with: docker compose logs --since 2m app" >&2
exit 1
