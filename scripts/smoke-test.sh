#!/usr/bin/env bash
# End to end API check against a throwaway database. Usage: bash scripts/smoke-test.sh
set -u
cd "$(dirname "$0")/.."
export DATA_DIR="$(mktemp -d)" ADMIN_PASSWORD='smoke-test-password' PORT=3987 UPI_ID='ideathon@upi' CAPTCHA_TEST_CODE=24680 REGISTER_RATE_LIMIT=500 DATA_KEY='smoke-test-data-key-0123456789abcdef'
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
member() { echo "{\"name\":\"Student $1\",\"roll\":\"R$2\",\"branch\":\"CSE\",\"phone\":\"$3\",\"section\":\"A\"}"; }
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
check "precheck: repeated roll"  'more than once in your team' "$(precheck 2 Fresh '"RZ1","rz 1"')"
check "precheck: flags the second one" '"m1-roll":"This ERP ID is repeated' "$(precheck 2 Fresh '"RZ1","RZ2","RZ1"' | sed 's/m2-roll/m1-roll/')"
check "precheck: team name"    'team name is taken'        "$(precheck 1 ALPHA '"RZ1","RZ2"')"
check "member in two teams"    'A student cannot be in two teams' "$(reg "$(team 1 Second A 232323232323 5)")"
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
check "upload encrypted on disk"  'IDT1'                    "$(for f in "$DATA_DIR"/uploads/*.jpg; do head -c 4 "$f"; break; done)"
check "database encrypted on disk" 'no'                     "$(head -c 15 "$DATA_DIR/ideathon.db" | grep -q -a 'SQLite format 3' && echo yes || echo no)"
check "no names in database file" '0'                       "$(cat "$DATA_DIR"/ideathon.db* | grep -c -a 'Student A' || true)"
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
check "any number of events"   '"participation":"any"'     "$(admin PUT /settings '{"participation":"any"}')"
check "multi event allowed"    '"status":"pending"'        "$(reg "$(team 3 Alpha A 121212121212 5)")"
check "back to one per half"   '"participation":"perHalf"' "$(admin PUT /settings '{"participation":"perHalf"}')"
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
ROSTER='ERP ID,Name,Branch,Section,Phone,Email ID\nRT1,Asha Rao,CSE,Sec A,9876500001,Asha.Rao@dbit.example\nRT2,Vikram N,ECE,b,,\nRT3,Divya S,ISE,A,,\nRT4,Rahul K,CSE,C,,\nRT5,Meera P,CSE,A,,\nbad roll!,Nobody,CSE,A,,\nRT2,Duplicate,CSE,A,,'
check "roster needs a list"    'Upload the student list first' "$(admin PUT /settings '{"rosterRequired":true}')"
check "roster import"          '"imported":5,"skipped":2'  "$(admin POST /students/import "{\"kind\":\"text\",\"mode\":\"replace\",\"content\":\"$ROSTER\"}")"
check "roster bad file"        'No students were found'    "$(admin POST /students/import '{"kind":"text","content":"hello\nworld"}')"
check "roster search"          '"name":"Divya S"'          "$(admin GET '/students?q=divya')"
check "roster on"              '"rosterRequired":true'     "$(admin PUT /settings '{"rosterRequired":true,"matchLeaderPhone":true}')"
check "public shows roster"    '"rosterRequired":true'     "$(curl -s $B/api/public)"
check "lookup fills names"     '"students":[{"name":"As** Ra*","branch":"CSE","section":"A","email":"as***@dbit.example"},{"name":"Vi**** N","branch":"ECE","section":"B"}]' "$(precheck 5 Fresh '"rt1","RT2"')"
check "lookup unknown roll"    'not in the 1st year student list' "$(precheck 5 Fresh '"RT1","RX9"')"
rteam() { echo "{\"eventId\":5,\"teamName\":\"$1\",\"email\":\"lead@example.com\",\"members\":[{\"name\":\"Fake Name\",\"roll\":\"RT1\",\"branch\":\"Hacker\",\"phone\":\"$2\"},{\"roll\":\"RT2\"},{\"roll\":\"RT3\"},{\"roll\":\"RT4\"},{\"roll\":\"$3\"}],\"utr\":\"$4\",\"screenshot\":\"$PNG\",\"consentPrivacy\":true,\"consentFirstYear\":true}"; }
check "unlisted roll refused"  'not in the 1st year student list' "$(reg "$(rteam Listed 9876500001 RX9 787878787878)")"
check "leader phone mismatch"  'does not match the one the college has' "$(reg "$(rteam Listed 9876599999 RT5 787878787878)")"
check "listed team registers"  '"status":"pending"'        "$(reg "$(rteam Listed 9876500001 RT5 787878787878)")"
check "email comes from list"  '"leaderEmail":"asha.rao@dbit.example"' "$(admin GET '/registrations?q=RT1')"
check "member email stays hidden" '"students":[{"name":"Vi**** N","branch":"ECE","section":"B"},{"name":"As** Ra*","branch":"CSE","section":"A"}]' "$(precheck 4 Fresh '"RT2","RT1"' | sed 's/.*\("students".*\)}/\1/')"
check "lookup never shows full name" 'no' "$(precheck 5 Fresh '"RT1","RT2","RT3"' | grep -q 'Asha Rao\|Vikram\|Divya' && echo yes || echo no)"
check "names come from list"   '"name":"Asha Rao","roll":"RT1","branch":"CSE"' "$(admin GET '/registrations?q=RT1')"
check "remove student"         '"count":4'                 "$(admin DELETE /students/RT5 '{}')"
check "clear list turns it off" '"count":0,"withPhone":0,"withEmail":0,"withSection":0,"rosterRequired":false' "$(admin DELETE /students '{}')"
# ---- email verification ----
MAILS="$DATA_DIR/mails.jsonl"
VROSTER='ERP ID,Name,Branch,Section,Email\nRV1,Leela Nair,CSE,A,leela.nair@dbit.example\nRV2,Arjun M,ECE,B,\nRV3,Sana K,ISE,A,\nRV4,Tarun P,CSE,C,\nRV5,Nisha R,CSE,A,'
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
# ---- adding and editing registrations by hand ----
mm() { echo "{\"name\":\"$1\",\"roll\":\"$2\",\"branch\":\"CSE\",\"phone\":\"${3:-}\"}"; }
mteam() { echo "{\"eventId\":3,\"teamName\":\"$1\",\"leaderEmail\":\"manual@example.com\",\"status\":\"${3:-approved}\",\"note\":\"Paid cash to the coordinator\",\"utr\":\"${4:-}\",\"override\":${5:-false},\"members\":[$2]}"; }
FIVE="$(mm 'Mona A' rm1 9876522222),$(mm 'Mohan B' RM2),$(mm 'Mary C' RM3),$(mm 'Mani D' RM4),$(mm 'Maya E' RM5)"
MADD=$(admin POST /registrations "$(mteam 'Manual Team' "$FIVE")")
MID=$(echo "$MADD" | sed 's/.*"registration":{"id":\([0-9]*\).*/\1/')
check "organiser adds a team"   '"source":"admin"'           "$MADD"
check "added team is approved"  '"status":"approved"'        "$MADD"
check "amount worked out"       '"amount":250'               "$MADD"
check "no screenshot needed"    '"hasScreenshot":false'      "$MADD"
check "ERP IDs tidied"     '"roll":"RM1"'               "$MADD"
check "screenshot says why"     'added by an organiser'      "$(admin GET /registrations/$MID/screenshot)"
check "taken roll names the team" 'Already in team \"Manual Team\"' "$(admin POST /registrations "$(mteam 'Copycat' "$(mm 'Mona A' RM1 9876522222),$(mm 'New One' RN2),$(mm 'New Two' RN3),$(mm 'New Three' RN4),$(mm 'New Four' RN5)")")"
check "taken team name"         'already uses this name'     "$(admin POST /registrations "$(mteam 'manual team' "$(mm 'N A' RN1 9876522223),$(mm 'N B' RN2),$(mm 'N C' RN3),$(mm 'N D' RN4),$(mm 'N E' RN5)")")"
check "leader needs a phone"    "leader's 10 digit"          "$(admin POST /registrations "$(mteam 'No Phone' "$(mm 'N A' RN1),$(mm 'N B' RN2),$(mm 'N C' RN3),$(mm 'N D' RN4),$(mm 'N E' RN5)")")"
check "bad transaction id"      'has 12 digits'              "$(admin POST /registrations "$(mteam 'Bad Utr' "$(mm 'N A' RN1 9876522223),$(mm 'N B' RN2),$(mm 'N C' RN3),$(mm 'N D' RN4),$(mm 'N E' RN5)" approved 12345)")"
check "small team asks first"   '"needsOverride":true'       "$(admin POST /registrations "$(mteam 'Tiny' "$(mm 'N A' RN1 9876522223),$(mm 'N B' RN2)" pending)")"
TINY=$(admin POST /registrations "$(mteam 'Tiny' "$(mm 'N A' RN1 9876522223),$(mm 'N B' RN2)" pending '' true)")
check "small team after confirming" '"memberCount":2'        "$TINY"
check "can be added as pending" '"status":"pending"'         "$TINY"
check "public form sees the hand added roll" 'already registered' "$(precheck 2 Fresh '"RM3","RZ9"')"
# edit: drop RM5, bring in RM6, make RM2 the leader
EDIT=$(admin PUT /registrations/$MID "$(mteam 'Manual Team Renamed' "$(mm 'Mohan B' RM2 9876544444),$(mm 'Mona A' rm1),$(mm 'Mary C' RM3),$(mm 'Mani D' RM4),$(mm 'Mita F' RM6)")")
check "edit: new leader first"  '"members":[{"name":"Mohan B","roll":"RM2"' "$EDIT"
check "edit: leader phone follows" '"leaderPhone":"9876544444"' "$EDIT"
check "edit: member swapped"    '"roll":"RM6"'               "$EDIT"
check "edit: team renamed"      '"teamName":"Manual Team Renamed"' "$EDIT"
check "edit: status kept"       '"status":"approved"'        "$EDIT"
check "removed member is free"  '"ok":true'                  "$(precheck 2 Fresh '"RM5","RZ9"')"
check "added member is taken"   'already registered'         "$(precheck 2 Fresh '"RM6","RZ9"')"
GROW=$(admin PUT /registrations/$MID "$(mteam 'Manual Team Renamed' "$(mm 'Mohan B' RM2 9876544444),$(mm 'Mona A' RM1),$(mm 'Mary C' RM3),$(mm 'Mani D' RM4),$(mm 'Mita F' RM6),$(mm 'Maya E' RM5)")")
check "edit: amount follows size" '"amount":300'             "$GROW"
check "edit: old amount reported" '"amountBefore":250'       "$GROW"
check "edit: cannot take another team's member" 'Already in team \"Tiny\"' "$(admin PUT /registrations/$MID "$(mteam 'Manual Team Renamed' "$(mm 'Mohan B' RM2 9876544444),$(mm 'N A' RN1),$(mm 'Mary C' RM3),$(mm 'Mani D' RM4),$(mm 'Mita F' RM6)")")"
check "edit: repeated roll"     'repeated in the team'       "$(admin PUT /registrations/$MID "$(mteam 'Manual Team Renamed' "$(mm 'Mohan B' RM2 9876544444),$(mm 'Twin' RM2),$(mm 'Mary C' RM3),$(mm 'Mani D' RM4),$(mm 'Mita F' RM6)")")"
check "edit: too small asks first" '"needsOverride":true'    "$(admin PUT /registrations/$MID "$(mteam 'Manual Team Renamed' "$(mm 'Mohan B' RM2 9876544444),$(mm 'Mona A' RM1)")")"
REJ=$(admin GET '/registrations?status=rejected' | grep -o '"id":[0-9]*,"code"' | head -1 | grep -o '[0-9]*')
check "edit: rejected is final" 'cannot be edited'           "$(admin PUT /registrations/$REJ "$(mteam 'X' "$FIVE")")"
check "edit: unknown registration" 'Registration not found'  "$(admin PUT /registrations/99999 "$(mteam 'X' "$FIVE")")"
check "log records the edit"    'registration.edited'        "$(admin GET /audit)"
check "log says what changed"   'added RM6; removed RM5; leader is now RM2' "$(admin GET /audit)"
check "export marks hand added" 'Organiser'                  "$(admin GET '/export?format=csv&q=Manual')"

# ---- single students ----
check "add one student"         '"name":"Solo Kid"'          "$(admin POST /students '{"roll":"rs1","name":"Solo Kid","branch":"CSE","email":"solo@dbit.example"}')"
check "add: already listed"     'already on the list'        "$(admin POST /students '{"roll":"RS1","name":"Again"}')"
check "add: bad roll"           'valid ERP ID'          "$(admin POST /students '{"roll":"!!","name":"Bad"}')"
check "add: bad email"          'valid email'                "$(admin POST /students '{"roll":"RS2","name":"Bad Mail","email":"nope"}')"
check "edit a student"          '"name":"Solo Kid Renamed","branch":"ECE","phone":"9876533333"' "$(admin PUT /students/rs1 '{"name":"Solo Kid Renamed","branch":"ECE","phone":"9876533333","email":""}')"
check "edit: unknown student"   'not on the list'            "$(admin PUT /students/NOPE1 '{"name":"Nobody"}')"
check "edit: name required"     'Enter the name'             "$(admin PUT /students/RS1 '{"name":""}')"
check "lookup for the editor"   '"name":"Solo Kid Renamed"'  "$(admin POST /students/lookup '{"rolls":["rs1","NOPE1"]}')"
admin POST /students '{"roll":"RM3","name":"Mary C"}' > /dev/null
check "fixing a name updates the team too" '"registrationsUpdated":1' "$(admin PUT /students/RM3 '{"name":"Mary Corrected","branch":"ISE"}')"
check "team shows the fixed name" '"name":"Mary Corrected","roll":"RM3","branch":"ISE"' "$(admin GET '/registrations?q=RM3')"
check "list name wins in the editor" '"name":"Mary Corrected"' "$(admin PUT /registrations/$MID "$(mteam 'Manual Team Renamed' "$(mm 'Mohan B' RM2 9876544444),$(mm 'Mona A' RM1),$(mm 'Typed Wrong' RM3),$(mm 'Mani D' RM4),$(mm 'Mita F' RM6)")")"
admin DELETE /students '{}' > /dev/null

# ---- sections ----
check "public info lists sections" '"sections":["A","B"'    "$(curl -s $B/api/public)"
check "section is required"     'Select the section'         "$(reg "$(team 5 Sectionless W 919191919191 5 | sed 's/,"section":"A"//g')")"
check "nonsense section refused" 'Select the section'        "$(reg "$(team 5 Sectionless W 919191919191 5 | sed 's/"section":"A"/"section":"!!"/g')")"
check "section typed loosely"   '"status":"pending"'         "$(reg "$(team 5 Sectioned W 919191919191 5 | sed 's/"section":"A"/"section":"sec b"/g')")"
check "section stored"          '"roll":"RW1","branch":"CSE","phone":"9876543210","section":"B"' "$(admin GET '/registrations?q=RW1')"
check "filter by section"       '"teamName":"Sectioned"'     "$(admin GET '/registrations?section=b')"
check "filter leaves others out" 'no'                        "$(admin GET '/registrations?section=H' | grep -q Sectioned && echo yes || echo no)"
check "export has a section column" '"Branch","Section","Phone"' "$(admin GET '/export?format=csv&layout=participants&q=Sectioned' | head -1)"
check "export shows the section" '"RW1","CSE","B"'           "$(admin GET '/export?format=csv&layout=participants&q=Sectioned')"
check "team export shows the section" 'Sec B'                "$(admin GET '/export?format=csv&layout=teams&q=Sectioned')"
check "sections go up to P"     '"N","O","P"]'               "$(curl -s $B/api/public)"
check "other is offered"        '"allowOtherSection":true'   "$(curl -s $B/api/public)"
check "section P accepted"      '"status":"pending"'         "$(reg "$(team 5 SectionP PP 969696969696 5 | sed 's/"section":"A"/"section":"p"/g')")"
check "typed section accepted"  '"status":"pending"'         "$(reg "$(team 2 Typed X 959595959595 6 | sed 's/"section":"A"/"section":"sec q2"/g')")"
check "typed section stored tidy" '"roll":"RX1","branch":"CSE","phone":"9876543210","section":"Q2"' "$(admin GET '/registrations?q=RX1')"
check "filter finds a typed section" '"teamName":"Typed"'    "$(admin GET '/registrations?section=q2')"
check "typed section too long"  'Select the section'         "$(reg "$(team 2 Long Z 979797979797 6 | sed 's/"section":"A"/"section":"ABCDEFGHIJKLMNOPQRSTUVWXYZ"/g')")"
admin PUT /settings '{"allowOtherSection":false}' > /dev/null
check "other switched off: public" '"allowOtherSection":false' "$(curl -s $B/api/public)"
check "other switched off: typed refused" 'Select the section' "$(reg "$(team 2 Strict Z 979797979797 6 | sed 's/"section":"A"/"section":"Q9"/g')")"
admin PUT /settings '{"allowOtherSection":true}' > /dev/null
check "sections can be changed" '"sections":["P","Q"]'       "$(admin PUT /settings '{"sections":["p","Sec Q","p"],"allowOtherSection":false}')"
check "old section no longer offered" 'Select the section'   "$(reg "$(team 2 Newsec Y 929292929292 6)")"
check "sections need one entry" 'at least one section'       "$(admin PUT /settings '{"sections":[]}')"
admin PUT /settings '{"sections":["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P"],"allowOtherSection":true}' > /dev/null
admin POST /students/import "{\"kind\":\"text\",\"mode\":\"replace\",\"content\":\"USN,Student Name,Department,Sec,Mobile\\nRS7,Seema T,CSE,section c,9876577777\\nRS8,Sunil U,ECE,,\"}" > /dev/null
check "import reads the section column" '"section":"C"'      "$(admin GET '/students?q=RS7')"
check "department is not taken for the section" '"branch":"CSE"' "$(admin GET '/students?q=RS7')"
check "section count"           '"withSection":1'            "$(admin GET /students)"
check "lookup gives the section" '"section":"C"'             "$(admin POST /students/lookup '{"rolls":["RS7"]}')"
check "edit a student section"  '"section":"D"'              "$(admin PUT /students/RS7 '{"name":"Seema T","branch":"CSE","section":"d"}')"
admin PUT /settings '{"rosterRequired":true}' > /dev/null
check "list section reaches the form" '"section":"D"'        "$(precheck 2 Fresh '"RS7"')"
check "no section on the list: form asks" '{"name":"Su*** U","branch":"ECE","section":""}' "$(precheck 2 Fresh '"RS7","RS8"')"
LISTED="{\"eventId\":4,\"email\":\"s@example.com\",\"members\":[{\"roll\":\"RS7\",\"phone\":\"9876577777\",\"section\":\"H\"}],\"utr\":\"939393939393\",\"screenshot\":\"$PNG\",\"consentPrivacy\":true,\"consentFirstYear\":true}"
check "list section wins over the form" '"status":"pending"' "$(reg "$LISTED")"
check "stored section is the list one" '"roll":"RS7","branch":"CSE","phone":"9876577777","section":"D"' "$(admin GET '/registrations?q=RS7')"
check "fixing a section updates the entry" '"registrationsUpdated":1' "$(admin PUT /students/RS7 '{"name":"Seema T","branch":"CSE","section":"E"}')"
check "entry shows the new section" '"section":"E"'          "$(admin GET '/registrations?q=RS7')"
NOSEC="{\"eventId\":4,\"email\":\"t@example.com\",\"members\":[{\"roll\":\"RS8\",\"phone\":\"9876588888\"}],\"utr\":\"949494949494\",\"screenshot\":\"$PNG\",\"consentPrivacy\":true,\"consentFirstYear\":true}"
check "no list section: must be picked" 'Select the section' "$(reg "$NOSEC")"
admin PUT /settings '{"rosterRequired":false}' > /dev/null
admin DELETE /students '{}' > /dev/null

# ---- registration IDs with an event code ----
check "id has the event code and a number" 'IDT26-PP001'    "$CODE"
check "status lookup takes the new id" '"code":"IDT26-PP001"' "$(post /api/status "{\"code\":\"idt26-pp001\",\"phone\":\"9876543210\"}")"
check "second event counts on its own" '"code":"IDT26-TQ00'  "$(admin GET '/registrations?event=2')"
check "hand added team gets the next id" '"code":"IDT26-CF0' "$(admin GET '/registrations?q=Manual')"
check "codes come from the title" '"code":"TB"'              "$(admin GET /events)"
check "event code already in use" 'already uses the code PP' "$(admin POST /events '{"title":"Paper Plane","teamBased":false,"maxTeams":0,"fee":50,"code":"pp"}')"
check "event code must be letters" '2 to 4 capital letters'  "$(admin POST /events '{"title":"Bad Code","teamBased":false,"maxTeams":0,"fee":50,"code":"1"}')"
PARTY=$(admin POST /events '{"title":"Poster Party","teamBased":false,"maxTeams":0,"fee":50}')
check "a clashing code is avoided" 'yes'                     "$(echo "$PARTY" | grep -q '"title":"Poster Party"[^}]*"code":"PO"' && echo yes || echo no)"
PARTY_ID=$(echo "$PARTY" | grep -o '"id":[0-9]*,"title":"Poster Party"' | grep -o '[0-9]*' | head -1)

# ---- two halves: one event in each half ----
# Fetches an event, changes its half, and prints the body for PUT.
evslot() {
  admin GET /events > "$DATA_DIR/ev.json"
  node -e "const e=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).events.find((x)=>x.id==process.argv[2]);e.slot=process.argv[3];process.stdout.write(JSON.stringify(e))" "$DATA_DIR/ev.json" "$1" "$2"
}
check "set an event's half"     'yes'                        "$(admin PUT /events/1 "$(evslot 1 first)" | grep -q '"id":1,[^}]*"slot":"first"' && echo yes || echo no)"
admin PUT /events/2 "$(evslot 2 second)" > /dev/null
admin PUT /events/3 "$(evslot 3 first)" > /dev/null
admin PUT /events/4 "$(evslot 4 second)" > /dev/null
admin PUT /events/5 "$(evslot 5 second)" > /dev/null
check "codes survive an edit"   '"code":"PP"'                "$(admin GET /events)"
check "public page shows halves" '"slot":"second"'           "$(curl -s $B/api/public)"
check "rule is one per half"    '"participation":"perHalf"'  "$(curl -s $B/api/public)"
HALF1=$(reg "$(team 1 Halves H 818181818181 5)")
check "register in the 1st half" '"code":"IDT26-PP002"'      "$HALF1"
check "same half is blocked"    'already registered for Poster Presentation (1st half). A student can join one event in each half.' "$(precheck 3 Fresh '"RH1","RZ8"')"
check "other half is allowed"   '"ok":true'                  "$(precheck 2 Fresh '"RH1","RH2"')"
check "no half set counts as all day" 'already registered for Poster Presentation (1st half)' "$(precheck $PARTY_ID Fresh '"RH1"')"
check "register in the 2nd half" '"status":"pending"'        "$(reg "$(team 2 Halves H 828282828282 6)")"
check "a third event is blocked" 'already registered for Technical & General Quiz (2nd half)' "$(precheck 5 Fresh '"RH1","RZ8"')"
check "summary names the rule"  'already registered for an event at the same time. A student can join one event in each half.' "$(precheck 5 Fresh '"RH1","RZ8"')"
check "admin editor uses the same rule" 'Technical & General Quiz (2nd half)' "$(admin POST /registrations "$(mteam 'Half Clash' "$(mm 'Hema A' RH1 9876522299),$(mm 'New B' RZ6),$(mm 'New C' RZ7),$(mm 'New D' RZ8),$(mm 'New E' RZ9)" approved '' true | sed 's/"eventId":3/"eventId":5/')")"
check "rule: one event only"    '"participation":"one"'      "$(admin PUT /settings '{"participation":"one"}')"
check "one only: other half is blocked too" 'A student can join only one event' "$(precheck 1 Fresh '"RH6","RZ8"')"
check "unknown rule refused"    'Choose how many events'     "$(admin PUT /settings '{"participation":"lots"}')"
admin PUT /settings '{"participation":"perHalf"}' > /dev/null
check "back to one per half"    '"ok":true'                  "$(precheck 1 Fresh '"RH6","RZ8"')"
admin DELETE /events/$PARTY_ID '{}' > /dev/null

# ---- filters: half and branch, in the list and in exports ----
check "mixed branch team"       '"status":"pending"'         "$(reg "$(team 5 Mixed Q 838383838383 5 | sed 's/"roll":"RQ2","branch":"CSE"/"roll":"RQ2","branch":"ECE"/')")"
check "list shows the half"     '"eventSlot":"first"'        "$(admin GET '/registrations?q=Halves&event=1')"
check "filter by half"          '"teamName":"Mixed"'         "$(admin GET '/registrations?half=second')"
check "half filter leaves the other half out" 'no'           "$(admin GET '/registrations?half=second' | grep -q '"eventSlot":"first"' && echo yes || echo no)"
check "filter by branch"        '"teamName":"Mixed"'         "$(admin GET '/registrations?branch=ece')"
check "branch filter leaves others out" 'no'                 "$(admin GET '/registrations?branch=ece' | grep -q '"teamName":"Halves"' && echo yes || echo no)"
check "export has a half column" '"Reg ID","Event","Half","Team"' "$(admin GET '/export?format=csv&layout=participants&q=Mixed' | head -1)"
check "export shows the half"   '"Treasure Hunt + Bounty","2nd half"' "$(admin GET '/export?format=csv&layout=participants&q=Mixed')"
check "branch export keeps that branch" '"RQ2","ECE"'        "$(admin GET '/export?format=csv&layout=participants&branch=ECE&q=Mixed')"
check "branch export drops the rest" 'no'                    "$(admin GET '/export?format=csv&layout=participants&branch=ECE&q=Mixed' | grep -q '"RQ1"' && echo yes || echo no)"
check "team export keeps the whole team" '5'                 "$(admin GET '/export?format=csv&layout=teams&branch=ECE&q=Mixed' | grep -o 'Student [AB] (RQ[0-9]' | wc -l | tr -d ' ')"
check "event and half together" 'no'                         "$(admin GET '/registrations?event=1&half=second' | grep -q '"teamName"' && echo yes || echo no)"
check "team export has a half column" '"Reg ID","Event","Half","Team","Members"' "$(admin GET '/export?format=csv&layout=teams&half=first' | head -1)"

# ---- organiser accounts ----
check "weak organiser password" 'at least 12 characters'   "$(admin POST /organisers '{"username":"priya","password":"short"}')"
check "bad organiser username" 'Usernames are 3 to 30'     "$(admin POST /organisers '{"username":"P R","password":"a-long-enough-password"}')"
check "owner name is reserved" 'belongs to the owner'      "$(admin POST /organisers '{"username":"admin","password":"a-long-enough-password"}')"
check "add organiser"          '"username":"priya"'        "$(admin POST /organisers '{"username":"Priya","password":"a-long-enough-password"}')"
check "duplicate organiser"    'already taken'             "$(admin POST /organisers '{"username":"priya","password":"another-long-password"}')"
OJAR="$DATA_DIR/ojar"
OLOGIN=$(curl -s -c "$OJAR" -X POST $B/api/admin/login -H "$J" -d '{"username":"priya","password":"a-long-enough-password"}')
OCSRF=$(echo "$OLOGIN" | sed 's/.*"csrf":"\([^"]*\)".*/\1/')
org() { curl -s -b "$OJAR" -X "$1" "$B/api/admin$2" -H "$J" -H "X-CSRF-Token: $OCSRF" ${3:+-d "$3"}; }
check "organiser signs in"     '"username":"priya","csrf"' "$OLOGIN"
check "organiser is not owner" '"owner":false'             "$OLOGIN"
check "organiser can work"     '"registrations":['         "$(org GET /registrations)"
check "organiser cannot add accounts" 'Only the owner'     "$(org POST /organisers '{"username":"friend","password":"a-long-enough-password"}')"
check "organiser cannot remove accounts" 'Only the owner'  "$(org DELETE /organisers/priya '{}')"
check "organiser wrong current password" 'current password is not right' "$(org POST /password '{"current":"nope","next":"a-brand-new-password"}')"
check "organiser changes password" '"ok":true'             "$(org POST /password '{"current":"a-long-enough-password","next":"a-brand-new-password"}')"
check "old password stops working" 'Wrong username'        "$(post /api/admin/login '{"username":"priya","password":"a-long-enough-password"}')"
org PUT /settings '{"notice":""}' > /dev/null
check "log names the organiser" '"actor":"priya","action":"settings.updated"' "$(admin GET /audit)"
check "owner cannot change password here" 'ADMIN_PASSWORD' "$(admin POST /password '{"current":"x","next":"a-brand-new-password"}')"
check "remove organiser"       '"organisers":[]'           "$(admin DELETE /organisers/priya '{}')"
check "removed organiser is signed out" 'Please sign in'   "$(org GET /registrations)"
check "removed organiser cannot sign in" 'Wrong username'  "$(post /api/admin/login '{"username":"priya","password":"a-brand-new-password"}')"
check "csv export"             'Reg ID'                    "$(admin GET '/export?format=csv&layout=participants&status=approved')"
check "xlsx export"            'PK'                        "$(admin GET '/export?format=xlsx' | head -c 2)"
check "add event"              '"title":"Debate"'          "$(admin POST /events '{"title":"Debate","teamBased":true,"minMembers":2,"maxMembers":3,"maxTeams":1,"fee":50}')"
DEBATE=$(admin GET /events | grep -o '"id":[0-9]*,"title":"Debate"' | grep -o '[0-9]*' | head -1)
check "one word title gets a code" 'yes'                     "$(admin GET /events | grep -q '"title":"Debate"[^}]*"code":"D[A-Z0-9]*"' && echo yes || echo no)"
check "bad event"              'cannot be more'            "$(admin POST /events '{"title":"X1","teamBased":true,"minMembers":5,"maxMembers":3,"maxTeams":0,"fee":50}')"
check "capacity ok"            '"status":"pending"'        "$(reg "$(team $DEBATE One K 777777777777 2)")"
check "capacity full"          'is full'                   "$(reg "$(team $DEBATE Two L 888888888888 2)")"
check "close registrations"    '"state":"closed"'          "$(admin PUT /settings '{"regMode":"closed"}')"
check "closed blocks register" 'Registrations are closed'  "$(reg "$(team 3 Late Z 999999999999 5)")"
check "schedule future"        '"state":"upcoming"'        "$(admin PUT /settings '{"regMode":"scheduled","opensAt":"2099-01-01T00:00:00Z","closesAt":""}')"
check "overview"               '"approved":{"teams":3'     "$(admin GET /overview | sed 's/"status":"approved",//')"
check "audit"                  'registration.approved'     "$(admin GET /audit)"
check "delete"                 '"ok":true'                 "$(admin DELETE /registrations/3 '{}')"
check "logout"                 '"ok":true'                 "$(admin POST /logout '{}')"
check "session revoked"        'Please sign in'            "$(admin GET /registrations)"

echo; echo "$pass passed, $fail failed"
[[ $fail -gt 0 ]] && { echo '--- server log'; cat "$DATA_DIR/server.log"; }
exit $fail
