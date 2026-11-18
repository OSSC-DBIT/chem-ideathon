# Documentation

Everything about the Ideathon '26 registration site, by audience.

| You are | Read |
| --- | --- |
| A student registering a team | [Student guide](student-guide.md) |
| An organiser using the admin panel | [Admin guide](admin-guide.md) |
| Setting the site up on the OSSC server | [Deploying on the OSSC server](deploy-ossc-server.md) |
| Running the site day to day: backups, the encryption key, updates, problems | [Operations](operations.md) |
| Changing a setting | [Configuration](configuration.md) |
| Wanting to know how data is protected, and what is not protected | [Security](security.md) |
| A developer reading or changing the code | [Architecture](architecture.md), [API reference](api.md), [Testing](testing.md) |

Also in the repository root: [README](../README.md) (overview), [CONTRIBUTING](../CONTRIBUTING.md),
[SECURITY](../SECURITY.md) (how to report a vulnerability), [AGENTS](../AGENTS.md) (rules for AI coding agents).

## The site in one paragraph

Team leaders register a team for one event, pay the fee by UPI, and upload the payment screenshot.
Organisers check each payment against the bank statement and approve or reject it. The college's
1st year student list decides who may register, and the team leader proves who they are with a code
sent to the email on that list. Everything stored on the server is encrypted.

## Things every organiser should know

1. **The encryption key (`DATA_KEY`) cannot be recovered.** Keep a copy outside the server. See
   [Operations](operations.md#the-encryption-key).
2. **Never run `docker compose down -v`.** The `-v` deletes all registrations and screenshots.
3. **Take a backup before the event day** and after registrations close: `bash scripts/backup.sh`.
   See [Operations](operations.md#backup-and-restore).
4. **Give each organiser their own account** (Settings, Organiser accounts), so the activity log shows
   who did what.
