# Operations

Running the site day to day. Commands are run in the project folder on the server
(`/srv/chem-ideathon` in the [deployment guide](deploy-ossc-server.md)).

## Everyday commands

```sh
docker compose ps                    # are the three containers up and healthy
docker compose logs -f app           # live app log
docker compose logs --since 1h app   # last hour
docker compose up -d                 # apply a change in .env
git pull && docker compose up -d --build   # update to the latest code
docker compose stop                  # stop the site, keep the data
docker compose start                 # start it again
```

**Never run `docker compose down -v`.** The `-v` deletes the volumes: all registrations, the student
list and every screenshot.

## The encryption key

`DATA_KEY` in `.env` encrypts the database and every payment screenshot.

- **If the key is lost, the data is lost.** Nobody can recover it: not OSSC, not the college, not the
  authors of the software.
- **A backup is useless without the key** that was in use when the backup was taken.
- Store a copy **outside the server**: a password manager, or a sealed note with the faculty
  coordinator. Two people should know where it is.
- Do not put the key in the repository, a chat group or an email.

To check that encryption is on: the Overview tab shows a warning when it is off. On disk:

```sh
docker compose exec app sh -c 'head -c 15 /data/ideathon.db | grep -q "SQLite format 3" && echo PLAIN || echo encrypted'
```

### Changing the encryption key

Do this if the key may have leaked, or when handing the server to a new team.

1. Take a backup first: `bash scripts/backup.sh`.
2. In `.env`, move the current key to `DATA_KEY_OLD` and put the new key in `DATA_KEY`.
3. `docker compose up -d`
4. Check the log: `docker compose logs --since 2m app` should show
   `database: change the database key done` and how many uploads were moved to the new key.
5. Clear `DATA_KEY_OLD` in `.env`, run `docker compose up -d` again, and store the new key safely.

Backups taken before the change still need the **old** key. Keep it until those backups are deleted.

### Switching encryption on for an existing site

Set `DATA_KEY` and start. The existing database and screenshots are converted on that start; the log
says `database: encrypt the existing database done`. Nothing else is needed.

## Backup and restore

Use the two scripts. They take care of things that are easy to get wrong by hand.

### Backup

```sh
bash scripts/backup.sh                   # into ./backups/ideathon-<date>-<time>
bash scripts/backup.sh /mnt/usb/ideathon # or a folder you choose
```

- The app is stopped for a few seconds while the files are copied, so the database is never caught in
  the middle of a write. Visitors see "back in a minute", and the app starts again by itself.
- The backup holds the encrypted database and the encrypted screenshots. It is as unreadable as the
  data on the server, and can only be opened with the `DATA_KEY` that was in `.env` when it was taken.
- It refuses to write into a folder that already has files in it.
- **Move the backup off the server.** A backup on the same disk does not survive that disk failing.

Take one before the event day and one after registrations close.

The admin panel's Excel export is a second, human readable record of the registrations. It is not
encrypted, so treat it with care.

### Restore

```sh
bash scripts/restore.sh backups/ideathon-2026-11-27-180000
```

- It asks you to type `restore`, because it **replaces everything** currently on the site.
- It stops the app, empties the data volume, copies the backup in, gives the files back to the
  unprivileged user the app runs as, starts the app and waits until it is healthy.
- `.env` must contain the `DATA_KEY` the backup was made with. With the wrong key the app does not
  start and the script says so.

Do not restore by hand with `docker cp` alone: the copied files end up owned by root, and the app,
which runs without privileges, can then no longer write to its own database.

**Try a restore once before the event**, so you know the backup and the key really work together.

## Updating

```sh
git pull
docker compose up -d --build
docker compose ps
```

Database changes are applied automatically on start. The update keeps all data.

## Virus scanner

- It takes about a minute to load after a restart, and a few minutes on the first ever start while it
  downloads its definitions. It needs about 1.5 GB of memory.
- It updates its definitions by itself.
- While it is unavailable: with `SCAN_REQUIRED=false` (default) uploads are accepted, cleaned by
  re-encoding and marked "not virus scanned"; with `SCAN_REQUIRED=true` uploads are refused.
- On a machine short of memory you can stop it: `docker compose stop clamav`.

## Email

- **Check connection** on the Student list tab signs in to the mail server without sending.
- **Send test** sends one email.
- The app log has a `mail:` line for every failure, with the reason from the mail server.
- The daily counter resets at midnight UTC and after a restart.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Log says `attempt to write a readonly database` | Files in the data volume are owned by root, usually after copying data in by hand | `bash scripts/restore.sh <backup>`, which fixes the ownership |
| App container keeps restarting; log says `DATA_KEY must be set` | No key in `.env` | Add `DATA_KEY`, then `docker compose up -d` |
| Log says `DATA_KEY does not match this database` | Wrong key | Put back the right key. If you meant to change it, use `DATA_KEY_OLD` as described above. |
| Log says `ADMIN_PASSWORD must be set and at least 12 characters` | Password missing or short | Fix it in `.env` |
| `docker compose up` says `Set DATA_KEY in the .env file` | Variable missing | Add it |
| Site shows "back in a minute" | The app is restarting or down | `docker compose ps`, then `docker compose logs app` |
| Students see "Too many requests" | A whole network shares one address and hit a limit | Raise the limit in `.env` ([Configuration](configuration.md#rate-limits)); behind a tunnel check that visitor addresses are passed on |
| "Registrations are not open yet. Payment details are being set up." | No UPI ID | Admin panel, Settings |
| Verification emails do not arrive | Spam folder, wrong address on the list, or mail not working | Check connection and Send test; read the `mail:` lines in the log |
| "the mail server did not answer" | Mail server or tunnel down, or wrong port | On the server use port 587; on a laptop the `cloudflared` tunnel must be running |
| "the secure connection failed" | `SMTP_HOST` is not the name on the certificate | Use the real name and set `SMTP_ON_THIS_HOST` |
| Overview warns that the virus scanner is not responding | Still loading, or out of memory | Wait a minute; `docker compose logs clamav` |
| A screenshot will not open in the admin panel | The file is missing, or was encrypted with a different key | Check the log line `screenshot read failed` |
| Port already in use on start | Another service has the port | Change `HOST_PORT` in `.env` and the Cloudflare hostname |
| Forgot the owner password | | Set a new `ADMIN_PASSWORD` in `.env`, then `docker compose up -d` |
| An organiser forgot their password | | The owner removes the account and adds it again |

## After the event

1. Close registrations (Overview, Close now).
2. Export the final lists (Registrations, Excel) and take a last backup (`bash scripts/backup.sh`).
3. When the accounts are settled, delete the data, as the privacy policy promises:
   `docker compose down -v` in this one case, on purpose. Delete the backups and exports too.
4. Remove the Cloudflare hostname and free the port in the server's port table.
