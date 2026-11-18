# Testing

## Run everything

```sh
npm install
npm test
```

`npm test` runs two scripts, each against a throwaway data folder. It needs bash and curl (Git Bash
works on Windows) and takes about two minutes.

| Script | Checks | What it covers |
| --- | --- | --- |
| `scripts/smoke-test.sh` | about 130 | The whole API with encryption on: registration rules, captcha, uploads, admin sign in and CSRF, statement matching, exports, events, schedule, student list, email verification, organiser accounts |
| `scripts/encryption-test.sh` | 24 | Encryption across restarts: converting a plain database, encrypted files on disk, refusing a wrong or missing key, changing the key |

Each line of output is `ok` or `FAIL` with what was wanted and what came back. The exit code is the
number of failures.

CI (`.github/workflows/ci.yml`) runs the same command on every push and pull request, plus a syntax
check, a dependency audit, a Docker build and an nginx configuration check.

## How the API tests work

`scripts/smoke-test.sh` starts the server on port 3987 with test settings, then makes requests with
curl and compares each reply with an expected piece of text:

```sh
check "duplicate team name"    'team name is already'      "$(reg "$(team 1 alpha C 222222222222 5)")"
```

Helpers defined in the script:

| Helper | Does |
| --- | --- |
| `check NAME EXPECTED ACTUAL` | Passes when `ACTUAL` contains `EXPECTED` |
| `post PATH JSON` | A public POST |
| `team EVENT NAME ROLLPREFIX UTR COUNT` | Builds a registration body with `COUNT` members |
| `reg BODY [ANSWER]` | Fetches a captcha, adds it to the body, and registers |
| `admin METHOD PATH [JSON]` | An admin call with the session cookie and CSRF token |
| `precheck EVENT TEAM ROLLS` | The pre-payment check |

Tests run in order against one database, so later checks depend on earlier ones. Read the
neighbouring lines before adding one.

## Test switches

Both are ignored when `NODE_ENV=production`.

| Variable | Effect |
| --- | --- |
| `CAPTCHA_TEST_CODE=24680` | Every captcha accepts this answer |
| `MAIL_TEST_FILE=path` | Emails are appended to this file as JSON lines; the tests read the code from it |

## Checking a page change by hand

There are no automated browser tests in the repository. For a change to the page or the admin panel:

```sh
ADMIN_PASSWORD=dev-password UPI_ID=test@upi CAPTCHA_TEST_CODE=24680 MAIL_TEST_FILE=./data/mails.jsonl npm run dev
```

Then, in a browser:

1. Open `http://localhost:3000` at about 360 px wide (phone) and at desktop width.
2. Register a team all the way through. The captcha answer is `24680`.
3. Open `/admin` (username `admin`), approve the registration, and check the status on the public page.
4. If the change touches the student list or email, upload `public/student-list-template.csv`, switch
   the checks on, and read the verification code from `./data/mails.jsonl`.
5. Look at the browser console: there should be no errors.

## Checking the Docker setup

```sh
docker compose up -d --build
curl -s http://127.0.0.1:8094/healthz
docker compose logs --since 2m app
```

To see how the site behaves when the app is down: `docker compose stop app`, load the site (it should
say "back in a minute"), then `docker compose start app`.

To test the virus scanner, upload a file containing the standard EICAR test string as a bank
statement. It should be refused, and the activity log should show `upload.blocked`.
