# Contributing

Thanks for helping with the Ideathon '26 registration site. This guide gets you from a fresh clone to a
merged pull request. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Set up

You need Node.js 22.13 or newer. Docker is only needed to test the full stack.

```sh
git clone https://github.com/OSSC-DBIT/chem-ideathon.git
cd chem-ideathon
npm install
```

Start the app for development (it restarts when a file changes):

```sh
# bash
ADMIN_PASSWORD=dev-password UPI_ID=test@upi CAPTCHA_TEST_CODE=24680 npm run dev

# PowerShell
$env:ADMIN_PASSWORD='dev-password'; $env:UPI_ID='test@upi'; $env:CAPTCHA_TEST_CODE='24680'; npm run dev
```

Open `http://localhost:3000` for the site and `/admin` for the admin panel (username `admin`).

Handy development switches. They are ignored when `NODE_ENV=production`:

| Variable | Effect |
| --- | --- |
| `CAPTCHA_TEST_CODE=24680` | Every captcha accepts this answer, so you can submit the form quickly. |
| `MAIL_TEST_FILE=./data/mails.jsonl` | Emails are written to this file, one JSON object per line, and nothing is sent. |

Data lives in `./data` (SQLite database and uploads). Delete the folder to start fresh.

## Before you open a pull request

1. Run the tests: `npm test`. This starts the server on a temporary database and runs about a hundred
   end to end checks with `curl`. It needs bash (Git Bash works on Windows).
2. If you changed the page or the admin panel, open it in a browser at phone width (around 360 px)
   and at desktop width, and click through what you changed.
3. If you changed `Dockerfile`, `docker-compose.yml` or `nginx/`, run `docker compose up -d --build`
   and check that the site loads on port 8080.

## How to contribute

1. Pick an issue, or open one to describe what you want to change. For anything bigger than a small
   fix, wait for a maintainer to agree on the approach before writing code.
2. Create a branch from `main`: `git checkout -b fix/short-description`.
3. Keep the pull request focused on one thing. Small pull requests get reviewed faster.
4. Describe what changed and how you tested it. Add a screenshot for visual changes.
5. A maintainer reviews it. Push follow up commits to the same branch; do not open a new pull request.

Commit messages: one short line saying what the change does ("Fix team size check for solo events"),
then a blank line and details if needed.

## Project rules

These keep the site safe and simple. Pull requests that break them will be asked to change.

- **The server decides.** Every rule (team size, one student one event, captcha, upload limits) is
  enforced in `src/`. Checks in the browser are only for a nicer experience.
- **No inline scripts or styles, no third party resources.** The Content Security Policy blocks them.
  Fonts and images are served from this site.
- **SQL uses placeholders.** Never build a query by joining strings with user input.
- **Anything a person typed is shown with `textContent`**, never `innerHTML`.
- **New dependencies need a reason.** The app has five. Ask in the issue first.
- **A new rule or endpoint comes with a check** in `scripts/smoke-test.sh`.
- **Error messages are for students.** Say what went wrong and what to do next, in plain words.
- **Never commit real data**: no `.env`, no database, no student lists, no payment screenshots,
  and no real names or roll numbers in tests, issues or screenshots.

## Reporting a security problem

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Questions

Ask in the OSSC channels listed at [webuildnow.in](https://webuildnow.in), or open an issue.
