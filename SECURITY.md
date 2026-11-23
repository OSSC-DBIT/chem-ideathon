# Security Policy

This site handles student names, roll numbers, phone numbers, email addresses and payment screenshots.
If you find a way to read, change or block that data when you should not be able to, we want to know.

## Reporting a problem

**Please do not open a public issue or post details in a group chat.**

1. Use GitHub's private reporting: on this repository open **Security**, then **Report a vulnerability**.
2. If that is not available to you, message an OSSC core team member directly. Contacts are at
   [webuildnow.in](https://webuildnow.in).

Include what you found, the steps to reproduce it, and what an attacker could do with it. If you saw
any real student data while testing, say so, do not keep a copy, and do not share it.

We aim to reply within 3 days and to fix confirmed problems before the event, or within 14 days,
whichever is sooner. We will credit you in the fix unless you ask us not to.

## Rules for testing

- Test on your own copy (`npm run dev` or `docker compose up`), not on the live site.
- Do not run load tests, spam registrations or send bulk emails against the live site.
- Do not access, change or delete other people's registrations.

## What is in scope

- The code in this repository: the app (`server.js`, `src/`), the pages (`public/`), the Docker and
  nginx configuration.

Out of scope: the college network and servers, GitHub itself, the email provider, and problems that
need physical access to the server or an admin password that was given to you.

## Supported versions

Only the latest commit on `main` is supported. The site is built for one event.

## How the site protects data

See the "Security notes" and "Uploads" sections of the [README](README.md).
