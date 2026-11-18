#!/usr/bin/env bash
# End to end API check against a throwaway database. Usage: bash scripts/smoke-test.sh
set -u
cd "$(dirname "$0")/.."
export DATA_DIR="$(mktemp -d)" ADMIN_PASSWORD='smoke-test-password' PORT=3987 UPI_ID='ideathon@upi' CAPTCHA_TEST_CODE=24680
export MAIL_TEST_FILE="$DATA_DIR/mails.jsonl"
node server.js > "$DATA_DIR/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:3987/healthz && break; sleep 0.5; done

B=http://127.0.0.1:3987
J='Content-Type: application/json'
JAR="$DATA_DIR/jar"
pass=0; fail=0
check() { # name, expected substring, actual
  if [[ "$3" == *"$2"* ]]; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1"; echo "     wanted: $2"; echo "     got:    ${3:0:300}"; fi
}

# A real 600x900 image stands in for the payment screenshot. Request bodies go through files
# because an image is too long for a command line argument.
PNG=$(node scripts/make-test-image.mjs good)
member() { echo "{\"name\":\"Student $1\",\"roll\":\"R$2\",\"branch\":\"CSE\",\"phone\":\"$3\"}"; }
team() { # eventId, teamName, rollPrefix, utr, count
  local m="$(member A "${3}1" 9876543210)"
  for i in $(seq 2 "$5"); do m="$m,$(member B "$3$i" "")"; done
  echo "{\"eventId\":$1,\"teamName\":\"$2\",\"email\":\"lead@example.com\",\"members\":[$m],\"utr\":\"$4\",\"screenshot\":\"$PNG\",\"consentPrivacy\":true,\"consentFirstYear\":true}"
}
post() { printf '%s' "$2" > "$DATA_DIR/body.json"; curl -s -X POST "$B$1" -H "$J" --data-binary @"$DATA_DIR/body.json"; }
# Registers with a solved captcha (the test server uses a fixed answer). Optional 2nd argument overrides the answer.
reg() {
  setjson "$1" captchaId "$(captcha_id)" captchaAnswer "${2:-24680}"; send
}
setjson() { local src="$DATA_DIR/in.$RANDOM.json"; printf '%s' "$1" > "$src"; shift; node -e "const fs=require('fs');const b=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));for(let i=3;i<process.argv.length;i+=2){const v=process.argv[i+1];b[process.argv[i]]=v.startsWith('@')?fs.readFileSync(v.slice(1),'utf8'):v;}fs.writeFileSync(process.argv[2],JSON.stringify(b));" "$src" "$DATA_DIR/body.json" "$@"; rm -f "$src"; }
send() { curl -s -X POST "$B/api/register" -H "$J" --data-binary @"$DATA_DIR/body.json"; }
captcha_id() { curl -s "$B/api/captcha" | sed 's/.*"id":"\([^"]*\)".*/\1/'; }
with_image() { setjson "$(team 3 Delta D 666666666666 5)" screenshot "$1"; cat "$DATA_DIR/body.json"; }

check "public info"            '"state":"open"'            "$(curl -s $B/api/public)"
check "qr"                     '"upiLink":"upi://pay'      "$(curl -s "$B/api/qr?amount=250")"
check "too few members"        'needs 5 to 6'              "$(reg "$(team 1 Alpha A 111111111111 3)")"
check "captcha image"          '"image":"data:image/png'   "$(curl -s $B/api/captcha)"
check "no captcha"             'security check has expired' "$(post /api/register "$(team 1 Alpha A 111111111111 5)")"
check "wrong captcha"          'digits did not match'      "$(reg "$(team 1 Alpha A 111111111111 5)" 11111)"
CID=$(captcha_id)
withcid() { setjson "$1" captchaId "$CID" captchaAnswer 24680; cat "$DATA_DIR/body.json"; }
check "captcha first use"      '"status":"pending"'        "$(post /api/register "$(withcid "$(team 5 Once U 565656565656 5)")")"
check "captcha cannot be reused" 'security check has expired' "$(post /api/register "$(withcid "$(team 5 Twice V 676767676767 5)")")"
R1=$(reg "$(team 1 Alpha A 111111111111 5)")
check "register team"          '"amount":250'              "$R1"
CODE=$(echo "$R1" | sed 's/.*"code":"\([^"]*\)".*/\1/')
check "used utr needs no captcha" 'already been used'      "$(post /api/register "$(team 1 Beta B 111111111111 5)")"
check "duplicate utr"          'already been used'         "$(reg "$(team 1 Beta B 111111111111 5)")"
check "duplicate team name"    'team name is already'      "$(reg "$(team 1 alpha C 222222222222 5)")"
check "duplicate roll"         'already registered'        "$(reg "$(team 1 Gamma A 333333333333 5)")"
precheck() { post /api/precheck "{\"eventId\":$1,\"teamName\":\"$2\",\"rolls\":[$3]}"; }
check "precheck: free team"    '"ok":true'                 "$(precheck 2 Fresh '"RZ1","RZ2"')"
check "precheck: leader taken" 'You are already registered for Poster Presentation' "$(precheck 2 Fresh '"RA1","RZ2"')"
check "precheck: member taken" 'This student is already registered for Poster Presentation' "$(precheck 3 Fresh '"RZ1","RA3"')"
check "precheck: same event"   '"m1-roll"'                 "$(precheck 1 Fresh '"RZ1","RA2"')"
check "precheck: team name"    'team name is taken'        "$(precheck 1 ALPHA '"RZ1","RZ2"')"
check "member in two teams"    'A student can join only one event and one team' "$(reg "$(team 1 Second A 232323232323 5)")"
check "roll repeated in team"  'repeated in your team'     "$(reg "$(team 3 Twin Q 343434343434 5 | sed 's/"roll":"RQ2"/"roll":"RQ1"/')")"
check "retry is idempotent"    "\"code\":\"$CODE\""           "$(reg "$(team 1 Alpha A 111111111111 5)")"
check "one student one event"  'already registered for Poster Presentation' "$(reg "$(team 2 Alpha A 444444444444 6)")"
check "second team, new rolls" '"status":"pending"'        "$(reg "$(team 2 Alpha E 444444444444 6)")"
check "solo event"             '"memberCount":1'           "$(reg "$(team 4 x S 555555555555 1)")"
check "not an image"           'not a valid JPG'           "$(reg "$(with_image 'data:image/png;base64,AAAA')")"
check "wrong file type"        'must be a JPG, PNG or WebP' "$(reg "$(with_image 'data:application/pdf;base64,JVBERi0xLjQK')")"
check "image too small"        'too small to read'         "$(reg "$(with_image "$(node scripts/make-test-image.mjs tiny)")")"
check "corrupt image"          'damaged or could not be read' "$(reg "$(with_image "$(node scripts/make-test-image.mjs corrupt)")")"
node scripts/make-test-image.mjs huge > "$DATA_DIR/huge.txt"
setjson "$(team 3 Delta D 666666666666 5)" screenshot "@$DATA_DIR/huge.txt"
check "image over size limit"  'too large'                 "$(send)"
check "stored as clean jpeg"   'ffd8ff'                    "$(for f in "$DATA_DIR"/uploads/*.jpg; do od -An -tx1 -N3 "$f" | tr -d ' 
'; break; done)"
check "status lookup"          '"status":"pending"'        "$(post /api/status "{\"code\":\"$CODE\",\"phone\":\"9876543210\"}")"
check "status wrong phone"     'No registration found'     "$(post /api/status "{\"code\":\"$CODE\",\"phone\":\"9876543211\"}")"
check "cross site blocked"     'Cross site'                "$(curl -s -X POST $B/api/status -H "$J" -H 'Origin: https://evil.example' -d '{}')"

check "admin needs login"      'Please sign in'            "$(curl -s $B/api/admin/registrations)"
check "wrong password"         'Wrong username'            "$(post /api/admin/login '{"username":"admin","password":"nope"}')"
LOGIN=$(curl -s -c "$JAR" -X POST $B/api/admin/login -H "$J" -d '{"username":"admin","password":"smoke-test-password"}')
CSRF=$(echo "$LOGIN" | sed 's/.*"csrf":"\([^"]*\)".*/\1/')
check "login"                  '"csrf"'                    "$LOGIN"
admin() { curl -s -b "$JAR" -X "$1" "$B/api/admin$2" -H "$J" -H "X-CSRF-Token: $CSRF" ${3:+-d "$3"}; }
check "write without csrf"     'Security check failed'     "$(curl -s -b "$JAR" -X POST $B/api/admin/registrations/1/decision -H "$J" -d '{"status":"approved"}')"
check "list"                   '"teamName":"Alpha"'        "$(admin GET /registrations)"
check "search by roll"         '"code":"'"$CODE"'"'        "$(admin GET '/registrations?q=RA3&event=1')"
check "screenshot"             'ffd8ff'                    "$(admin GET /registrations/1/screenshot | od -An -tx1 -N3 | tr -d ' 
')"
check "scan status recorded"   '"scanStatus":"unscanned"'  "$(admin GET /registrations)"
check "overview shows scanner" '"scanner":{"configured":false' "$(admin GET /overview)"
STATEMENT='Date,Narration,Ref,Credit\n27/11/2026,UPI/CR/111111111111/STUDENT A/okaxis,111111111111,250.00\n27/11/2026,UPI/CR/444444444444/STUDENT A,444444444444,\"1,000.00\"'
REC=$(admin POST /reconcile "{\"kind\":\"text\",\"content\":\"$STATEMENT\"}")
check "reconcile match"        '"utr":"111111111111","amount":250,"found":true,"amountOk":true' "$REC"
check "reconcile wrong amount" '"utr":"444444444444","amount":300,"found":true,"amountOk":false' "$REC"
check "reconcile not found"    '"utr":"555555555555","amount":50,"found":false' "$REC"
check "bulk approve"           '"approved":1'              "$(admin POST /registrations/bulk-approve '{"ids":[1]}')"
check "reject needs reason"    'Give a reason'             "$(admin POST /registrations/2/decision '{"status":"rejected"}')"
check "reject"                 '"ok":true'                 "$(admin POST /registrations/2/decision '{"status":"rejected","reason":"Amount does not match"}')"
check "rejected is final"      'cannot be reopened'        "$(admin POST /registrations/2/decision '{"status":"approved"}')"
check "status shows reason"    'Amount does not match'     "$(post /api/status "{\"code\":\"$(admin GET '/registrations?status=rejected' | sed 's/.*"code":"\([^"]*\)".*/\1/')\",\"phone\":\"9876543210\"}")"
check "rejected frees slot"    '"status":"pending"'        "$(reg "$(team 2 Alpha E 444444444444 6)")"
check "allow multi event"      '"allowMultiEvent":true'    "$(admin PUT /settings '{"allowMultiEvent":true}')"
check "multi event allowed"    '"status":"pending"'        "$(reg "$(team 3 Alpha A 121212121212 5)")"
check "back to one event"      '"allowMultiEvent":false'   "$(admin PUT /settings '{"allowMultiEvent":false}')"
check "malformed json"         'Invalid request'           "$(post /api/status '{bad')"
check "wrong content type"     'Unsupported content type'  "$(curl -s -X POST $B/api/status -d 'x=1')"
check "unknown api route"      'Not found'                 "$(curl -s $B/api/nope)"
check "bad qr amount"          'Invalid amount'            "$(curl -s "$B/api/qr?amount=abc")"
check "missing registration"   'Registration not found'    "$(admin POST /registrations/99999/decision '{"status":"approved"}')"
check "bad statement file"     'Could not read that file'  "$(admin POST /reconcile '{"kind":"xlsx","content":"bm90IGEgemlw"}')"
check "bulk reject needs reason" 'Give a reason'           "$(admin POST /registrations/bulk-reject '{"ids":[1]}')"
BEFORE=$(admin GET '/registrations?status=pending' | grep -o '"id":[0-9]*,"code"' | head -1 | grep -o '[0-9]*')
check "bulk reject fake entry" '"rejected":1'              "$(admin POST /registrations/bulk-reject "{\"ids\":[$BEFORE],\"reason\":\"Not in statement\"}")"
# ---- student list ----
ROSTER='Roll number,Name,Branch,Phone,Email ID\nRT1,Asha Rao,CSE,9876500001,Asha.Rao@dbit.example\nRT2,Vikram N,ECE,\nRT3,Divya S,ISE,\nRT4,Rahul K,CSE,\nRT5,Meera P,CSE,\nbad roll!,Nobody,CSE,\nRT2,Duplicate,CSE,'
check "roster needs a list"    'Upload the student list first' "$(admin PUT /settings '{"rosterRequired":true}')"
check "roster import"          '"imported":5,"skipped":2'  "$(admin POST /students/import "{\"kind\":\"text\",\"mode\":\"replace\",\"content\":\"$ROSTER\"}")"
check "roster bad file"        'No students were found'    "$(admin POST /students/import '{"kind":"text","content":"hello\nworld"}')"
check "roster search"          '"name":"Divya S"'          "$(admin GET '/students?q=divya')"
check "roster on"              '"rosterRequired":true'     "$(admin PUT /settings '{"rosterRequired":true,"matchLeaderPhone":true}')"
check "public shows roster"    '"rosterRequired":true'     "$(curl -s $B/api/public)"
check "lookup fills names"     '"students":[{"name":"As** Ra*","branch":"CSE","email":"as***@dbit.example"},{"name":"Vi**** N","branch":"ECE"}]' "$(precheck 5 Fresh '"rt1","RT2"')"
check "lookup unknown roll"    'not in the 1st year student list' "$(precheck 5 Fresh '"RT1","RX9"')"
rteam() { echo "{\"eventId\":5,\"teamName\":\"$1\",\"email\":\"lead@example.com\",\"members\":[{\"name\":\"Fake Name\",\"roll\":\"RT1\",\"branch\":\"Hacker\",\"phone\":\"$2\"},{\"roll\":\"RT2\"},{\"roll\":\"RT3\"},{\"roll\":\"RT4\"},{\"roll\":\"$3\"}],\"utr\":\"$4\",\"screenshot\":\"$PNG\",\"consentPrivacy\":true,\"consentFirstYear\":true}"; }
check "unlisted roll refused"  'not in the 1st year student list' "$(reg "$(rteam Listed 9876500001 RX9 787878787878)")"
check "leader phone mismatch"  'does not match the one the college has' "$(reg "$(rteam Listed 9876599999 RT5 787878787878)")"
check "listed team registers"  '"status":"pending"'        "$(reg "$(rteam Listed 9876500001 RT5 787878787878)")"
check "email comes from list"  '"leaderEmail":"asha.rao@dbit.example"' "$(admin GET '/registrations?q=RT1')"
check "member email stays hidden" '"students":[{"name":"Vi**** N","branch":"ECE"},{"name":"As** Ra*","branch":"CSE"}]' "$(precheck 4 Fresh '"RT2","RT1"' | sed 's/.*\("students".*\)}/\1/')"
check "lookup never shows full name" 'no' "$(precheck 5 Fresh '"RT1","RT2","RT3"' | grep -q 'Asha Rao\|Vikram\|Divya' && echo yes || echo no)"
check "names come from list"   '"name":"Asha Rao","roll":"RT1","branch":"CSE"' "$(admin GET '/registrations?q=RT1')"
check "remove student"         '"count":4'                 "$(admin DELETE /students/RT5 '{}')"
check "clear list turns it off" '"count":0,"withPhone":0,"withEmail":0,"rosterRequired":false' "$(admin DELETE /students '{}')"
# ---- email verification ----
MAILS="$DATA_DIR/mails.jsonl"
VROSTER='Roll number,Name,Branch,Email\nRV1,Leela Nair,CSE,leela.nair@dbit.example\nRV2,Arjun M,ECE,\nRV3,Sana K,ISE,\nRV4,Tarun P,CSE,\nRV5,Nisha R,CSE,'
admin POST /students/import "{\"kind\":\"text\",\"mode\":\"replace\",\"content\":\"$VROSTER\"}" > /dev/null
check "verification on"        '"emailVerification":true'  "$(admin PUT /settings '{"rosterRequired":true,"emailVerification":true,"matchLeaderPhone":false}')"
check "public shows verify"    '"emailVerification":true'  "$(curl -s $B/api/public)"
check "test email"             '"ok":true'                 "$(admin POST /mail/test '{"to":"organiser@example.com"}')"
vteam() { echo "{\"eventId\":3,\"teamName\":\"Verified\",\"email\":\"attacker@evil.example\",\"members\":[{\"roll\":\"RV1\",\"phone\":\"9876511111\"},{\"roll\":\"RV2\"},{\"roll\":\"RV3\"},{\"roll\":\"RV4\"},{\"roll\":\"RV5\"}],\"utr\":\"898989898989\",\"screenshot\":\"$PNG\",\"consentPrivacy\":true,\"consentFirstYear\":true}"; }
check "no code without captcha" 'Type the digits'          "$(post /api/verify/send '{"roll":"RV1"}')"
check "unlisted roll gets no code" 'not in the 1st year student list' "$(post /api/verify/send "{\"roll\":\"RX1\",\"email\":\"x@y.co\",\"captchaId\":\"$(captcha_id)\",\"captchaAnswer\":\"24680\"}")"
check "code goes to list email" '"sentTo":"le***@dbit.example"' "$(post /api/verify/send "{\"roll\":\"RV1\",\"email\":\"attacker@evil.example\",\"captchaId\":\"$(captcha_id)\",\"captchaAnswer\":\"24680\"}")"
check "mail went to the student" '"to":"leela.nair@dbit.example"' "$(tail -1 "$MAILS")"
check "resend has to wait"     'Please wait'               "$(post /api/verify/send '{"roll":"RV1"}')"
check "register needs verify"  'Verify the team leader'    "$(reg "$(vteam)")"
check "wrong code"             'not right. 4 tries left'   "$(post /api/verify/check '{"roll":"RV1","code":"000000"}')"
check "malformed code"         'Enter the 6 digit code'    "$(post /api/verify/check '{"roll":"RV1","code":"12"}')"
OTP=$(tail -1 "$MAILS" | sed 's/.*"subject":"\([0-9]*\) is your.*/\1/')
VTOKEN=$(post /api/verify/check "{\"roll\":\"RV1\",\"code\":\"$OTP\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/')
check "right code gives token" 'yes'                       "$([ ${#VTOKEN} -ge 30 ] && echo yes || echo "no: $VTOKEN")"
check "code works only once"   'expired'                   "$(post /api/verify/check "{\"roll\":\"RV1\",\"code\":\"$OTP\"}")"
check "token of another leader" 'Verify the team leader'   "$(setjson "$(vteam | sed 's/"roll":"RV1"/"roll":"RV9"/;s/"roll":"RV2"/"roll":"RV1"/;s/"roll":"RV9"/"roll":"RV2"/')" verifyToken "$VTOKEN"; send)"
check "verified team registers" '"status":"pending"'       "$(setjson "$(vteam)" verifyToken "$VTOKEN"; send)"
check "received email sent"    'registration received'     "$(tail -1 "$MAILS")"
check "email is the list one"  '"leaderEmail":"leela.nair@dbit.example"' "$(admin GET '/registrations?q=RV1')"
VID=$(admin GET '/registrations?q=RV1' | grep -o '"id":[0-9]*,"code"' | head -1 | grep -o '[0-9]*')
admin POST "/registrations/$VID/decision" '{"status":"approved"}' > /dev/null
check "confirmed email sent"   'you are confirmed'         "$(tail -1 "$MAILS")"
admin PUT /settings '{"emailVerification":false,"rosterRequired":false}' > /dev/null
admin DELETE /students '{}' > /dev/null
check "csv export"             'Reg ID'                    "$(admin GET '/export?format=csv&layout=participants&status=approved')"
check "xlsx export"            'PK'                        "$(admin GET '/export?format=xlsx' | head -c 2)"
check "add event"              '"title":"Debate"'          "$(admin POST /events '{"title":"Debate","teamBased":true,"minMembers":2,"maxMembers":3,"maxTeams":1,"fee":50}')"
check "bad event"              'cannot be more'            "$(admin POST /events '{"title":"X1","teamBased":true,"minMembers":5,"maxMembers":3,"maxTeams":0,"fee":50}')"
check "capacity ok"            '"status":"pending"'        "$(reg "$(team 6 One K 777777777777 2)")"
check "capacity full"          'is full'                   "$(reg "$(team 6 Two L 888888888888 2)")"
check "close registrations"    '"state":"closed"'          "$(admin PUT /settings '{"regMode":"closed"}')"
check "closed blocks register" 'Registrations are closed'  "$(reg "$(team 3 Late Z 999999999999 5)")"
check "schedule future"        '"state":"upcoming"'        "$(admin PUT /settings '{"regMode":"scheduled","opensAt":"2099-01-01T00:00:00Z","closesAt":""}')"
check "overview"               '"approved":{"teams":2'     "$(admin GET /overview | sed 's/"status":"approved",//')"
check "audit"                  'registration.approved'     "$(admin GET /audit)"
check "delete"                 '"ok":true'                 "$(admin DELETE /registrations/3 '{}')"
check "logout"                 '"ok":true'                 "$(admin POST /logout '{}')"
check "session revoked"        'Please sign in'            "$(admin GET /registrations)"

echo; echo "$pass passed, $fail failed"
[[ $fail -gt 0 ]] && { echo '--- server log'; cat "$DATA_DIR/server.log"; }
exit $fail
