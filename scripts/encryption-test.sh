#!/usr/bin/env bash
# Tests encryption at rest across restarts: converting a plain database, refusing a wrong key,
# and changing the key. Usage: bash scripts/encryption-test.sh
set -u
cd "$(dirname "$0")/.."
DIR="$(mktemp -d)"
PORT=3986
B="http://127.0.0.1:$PORT"
J='Content-Type: application/json'
K1='first-test-key-0123456789-abcdefghij'
K2='second-test-key-9876543210-zyxwvutsrq'
PID=''
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1"; echo "     wanted: $2"; echo "     got:    ${3:0:300}"; fi; }

stop() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=''; }
trap stop EXIT

# start <DATA_KEY> <DATA_KEY_OLD>; returns 0 when the server came up, 1 when it exited
start() {
  stop
  DATA_DIR="$DIR" ADMIN_PASSWORD='encryption-test-pw' PORT=$PORT UPI_ID='test@upi' DATA_KEY="$1" DATA_KEY_OLD="${2:-}" \
    node server.js > "$DIR/server.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 40); do
    curl -s -o /dev/null "$B/healthz" && return 0
    kill -0 "$PID" 2>/dev/null || { PID=''; [ -n "${DEBUG_START:-}" ] && tail -4 "$DIR/server.log" >&2; return 1; }
    sleep 0.5
  done
  return 1
}
admin_events() {
  local csrf
  csrf=$(curl -s -c "$DIR/jar" -X POST "$B/api/admin/login" -H "$J" -d '{"username":"admin","password":"encryption-test-pw"}' | sed 's/.*"csrf":"\([^"]*\)".*/\1/')
  if [ -n "${1:-}" ]; then curl -s -b "$DIR/jar" -X POST "$B/api/admin/events" -H "$J" -H "X-CSRF-Token: $csrf" -d "$1"; else curl -s -b "$DIR/jar" "$B/api/admin/events"; fi
}
header() { head -c 15 "$DIR/ideathon.db" | tr -d '\0'; }
upload_magic() { head -c 4 "$DIR/uploads/legacy.jpg"; }
plaintext_in_db() { cat "$DIR"/ideathon.db* 2>/dev/null | grep -c -a "Marker Event Zeta" || true; }

# 1. A database and an upload from before encryption existed
start '' && r=up || r=down
check "starts without a key (development)" 'up' "$r"
check "create a record"                    '"title":"Marker Event Zeta"' "$(admin_events '{"title":"Marker Event Zeta","teamBased":false,"maxTeams":0,"fee":50}')"
printf '\xff\xd8\xff\xe0 pretend this is an old plain screenshot ........................' > "$DIR/uploads/legacy.jpg"
stop
check "plain database header"              'SQLite format 3' "$(header)"
check "plain database shows the data"      '1' "$( [ "$(plaintext_in_db)" -ge 1 ] && echo 1 || echo 0 )"

# 2. Switch encryption on: everything is converted on start
start "$K1" && r=up || r=down
check "starts with a key"                  'up' "$r"
check "log: database converted"            'encrypt the existing database done' "$(cat "$DIR/server.log")"
check "log: uploads converted"             '1 encrypted' "$(cat "$DIR/server.log")"
check "data survived the conversion"       'Marker Event Zeta' "$(admin_events)"
stop
check "database file is encrypted"         'no' "$( [[ "$(header)" == *'SQLite format 3'* ]] && echo yes || echo no )"
check "no readable data in the database"   '0' "$(plaintext_in_db)"
check "upload file is encrypted"           'IDT1' "$(upload_magic)"
check "no safety copy left behind"         '0' "$(ls "$DIR" | grep -c converting || true)"

# 3. Wrong or missing key: refuse to start, change nothing
start 'a-completely-different-key-000000000000' && r=up || r=down
check "wrong key: does not start"          'down' "$r"
check "wrong key: clear message"           'DATA_KEY does not match this database' "$(cat "$DIR/server.log")"
start '' && r=up || r=down
check "no key: does not start"             'down' "$r"
check "no key: clear message"              'encrypted but DATA_KEY is not set' "$(cat "$DIR/server.log")"
start 'short' && r=up || r=down
check "short key: refused"                 'too short' "$(cat "$DIR/server.log")"

# 4. Changing the key
start "$K2" "$K1" && r=up || r=down
check "key change: starts"                 'up' "$r"
check "log: database key changed"          'change the database key done' "$(cat "$DIR/server.log")"
check "log: uploads moved to new key"      '1 moved to the new key' "$(cat "$DIR/server.log")"
check "data survived the key change"       'Marker Event Zeta' "$(admin_events)"
start "$K2" && r=up || r=down
check "new key alone works"                'up' "$r"
check "data still there"                   'Marker Event Zeta' "$(admin_events)"
start "$K1" && r=up || r=down
check "old key no longer works"            'down' "$r"

stop
echo; echo "$pass passed, $fail failed"
exit $fail
