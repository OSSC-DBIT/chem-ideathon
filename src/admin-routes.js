import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db, tx, audit, getSettings, saveSettings, registrationState, eventToJson, UPLOAD_DIR } from './db.js';
import {
  requireAdmin, checkCredentials, createSession, destroySession, getSession, rateLimit, adminConfigured,
} from './security.js';
import { statementRows, matchStatement } from './reconcile.js';
import { buildTable, toCsv, toXlsx } from './export.js';
import { mailConfigured, mailInfo, mailsSentToday, sendMail, sendMailLater, messages, MailError, checkMailServer } from './mailer.js';
import { tableRows, readRoster, importStudents, studentCount, normaliseRoll } from './roster.js';
import { MAX_STATEMENT_BYTES, UploadError, scanOrThrow, scannerConfigured, scannerHealthy, scanRequired, limits } from './uploads.js';

export const router = express.Router();

const clean = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

// ---------------------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------------------
router.post(
  '/login',
  express.json({ limit: '10kb' }),
  rateLimit({ windowMs: 15 * 60 * 1000, max: 8, onlyFailures: true, message: 'Too many failed sign in attempts. Try again in 15 minutes.' }),
  (req, res) => {
    if (!adminConfigured) return res.status(503).json({ error: 'Admin access is not configured. Set ADMIN_PASSWORD.' });
    const { username, password } = req.body || {};
    if (!checkCredentials(username, password)) {
      audit('system', 'login.failed', `ip ${req.ip}`);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    const name = String(username).trim();
    const csrf = createSession(req, res, name);
    audit(name, 'login', `ip ${req.ip}`);
    res.json({ username: name, csrf });
  },
);

router.get('/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const session = adminConfigured ? getSession(req) : null;
  if (!session) return res.status(401).json({ error: 'Please sign in.' });
  res.json({ username: session.username, csrf: session.csrf });
});

router.post('/logout', express.json({ limit: '1kb' }), (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// Everything below needs a session (and a CSRF token for writes).
router.use(requireAdmin);
const smallJson = express.json({ limit: '100kb' });
router.use((req, res, next) => (req.path === '/reconcile' ? next() : smallJson(req, res, next))); // reconcile takes bigger uploads

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------
const membersOf = db.prepare('SELECT name, roll, branch, phone FROM members WHERE registration_id = ? ORDER BY position');
const getReg = db.prepare('SELECT r.*, e.title AS event_title FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.id = ?');
const setStatus = db.prepare('UPDATE registrations SET status = ?, reject_reason = ?, decided_by = ?, decided_at = ? WHERE id = ?');
const deleteReg = db.prepare('DELETE FROM registrations WHERE id = ?');

function regToJson(row) {
  return {
    id: row.id,
    code: row.code,
    eventId: row.event_id,
    eventTitle: row.event_title,
    teamName: row.team_name,
    leaderEmail: row.leader_email,
    leaderPhone: row.leader_phone,
    memberCount: row.member_count,
    amount: row.amount,
    utr: row.utr,
    status: row.status,
    rejectReason: row.reject_reason,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    scanStatus: row.scan_status,
    members: membersOf.all(row.id),
  };
}

/** Shared by the list and the exports, so exports always match what is on screen. */
function queryRegistrations(query) {
  const where = [];
  const params = [];
  const eventId = int(query.event, 1, 1e9, 0);
  if (eventId) { where.push('r.event_id = ?'); params.push(eventId); }
  if (['pending', 'approved', 'rejected'].includes(query.status)) { where.push('r.status = ?'); params.push(query.status); }
  const q = clean(query.q, 60);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push(`(
      r.code LIKE ? ESCAPE '\\' OR r.team_name LIKE ? ESCAPE '\\' OR r.utr LIKE ? ESCAPE '\\'
      OR r.leader_phone LIKE ? ESCAPE '\\' OR r.leader_email LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM members m WHERE m.registration_id = r.id AND (m.name LIKE ? ESCAPE '\\' OR m.roll LIKE ? ESCAPE '\\'))
    )`);
    params.push(like, like, like, like, like, like, like);
  }
  const sql = `
    SELECT r.*, e.title AS event_title FROM registrations r JOIN events e ON e.id = r.event_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC
  `;
  return db.prepare(sql).all(...params).map(regToJson);
}

router.get('/registrations', (req, res) => {
  res.json({ registrations: queryRegistrations(req.query) });
});

router.get('/registrations/:id/screenshot', (req, res) => {
  const row = getReg.get(int(req.params.id, 1, 1e9, 0));
  if (!row || !/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(row.screenshot)) return res.status(404).json({ error: 'Not found.' });
  const file = path.join(UPLOAD_DIR, row.screenshot);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Screenshot file is missing.' });
  const types = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  res.set({
    'Content-Type': types[row.screenshot.split('.').pop()],
    'Content-Disposition': 'inline',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  });
  fs.createReadStream(file)
    .on('error', (err) => {
      console.error('screenshot read failed:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Could not read the screenshot file.' });
      else res.destroy();
    })
    .pipe(res);
});

function decide(id, status, reason, actor) {
  const row = getReg.get(id);
  if (!row) return { error: 'Registration not found.', code: 404 };
  if (row.status === 'rejected') {
    return { error: 'A rejected registration cannot be reopened. Ask the team to register again.', code: 409 };
  }
  if (row.status === status) return { ok: true };
  setStatus.run(status, status === 'rejected' ? reason : '', status === 'pending' ? null : actor,
    status === 'pending' ? null : new Date().toISOString(), id);
  audit(actor, `registration.${status}`, `${row.code} ${row.team_name}${reason ? ` | ${reason}` : ''}`);
  // Tell the team leader by email (when email is set up). Never blocks or fails the decision.
  if (status === 'approved') sendMailLater(messages.approved(row.leader_email, { code: row.code, eventTitle: row.event_title }));
  if (status === 'rejected') sendMailLater(messages.rejected(row.leader_email, { code: row.code, eventTitle: row.event_title, reason }));
  return { ok: true };
}

router.post('/registrations/:id/decision', (req, res) => {
  const status = req.body?.status;
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const reason = clean(req.body?.reason, 200);
  if (status === 'rejected' && reason.length < 3) return res.status(400).json({ error: 'Give a reason for rejecting, so the team knows what to fix.' });
  const result = decide(int(req.params.id, 1, 1e9, 0), status, reason, req.admin.username);
  if (result.error) return res.status(result.code).json({ error: result.error });
  res.json({ ok: true });
});

router.post('/registrations/bulk-approve', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 1000).map((id) => int(id, 1, 1e9, 0)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'Nothing selected.' });
  let approved = 0;
  tx(() => {
    for (const id of ids) {
      const row = getReg.get(id);
      if (row && row.status === 'pending' && decide(id, 'approved', '', req.admin.username).ok) approved += 1;
    }
  });
  res.json({ approved });
});

// Clears out fake or unpaid entries in one go, which frees the roll numbers they were holding.
router.post('/registrations/bulk-reject', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 1000).map((id) => int(id, 1, 1e9, 0)).filter(Boolean) : [];
  const reason = clean(req.body?.reason, 200);
  if (!ids.length) return res.status(400).json({ error: 'Nothing selected.' });
  if (reason.length < 3) return res.status(400).json({ error: 'Give a reason for rejecting, so the teams know what to fix.' });
  let rejected = 0;
  tx(() => {
    for (const id of ids) {
      const row = getReg.get(id);
      if (row && row.status === 'pending' && decide(id, 'rejected', reason, req.admin.username).ok) rejected += 1;
    }
  });
  res.json({ rejected });
});

router.delete('/registrations/:id', (req, res) => {
  const row = getReg.get(int(req.params.id, 1, 1e9, 0));
  if (!row) return res.status(404).json({ error: 'Registration not found.' });
  deleteReg.run(row.id);
  if (/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(row.screenshot)) fs.rm(path.join(UPLOAD_DIR, row.screenshot), { force: true }, () => {});
  audit(req.admin.username, 'registration.deleted', `${row.code} ${row.team_name}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Export: same filters as the list. format = csv | xlsx | json, layout = teams | participants
// ---------------------------------------------------------------------------
router.get('/export', async (req, res, next) => {
  try {
    const layout = req.query.layout === 'participants' ? 'participants' : 'teams';
    const format = ['csv', 'xlsx', 'json'].includes(req.query.format) ? req.query.format : 'csv';
    const regs = queryRegistrations(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `ideathon26-${layout}-${stamp}`;
    audit(req.admin.username, 'export', `${format} ${layout} (${regs.length} registrations)`);

    if (format === 'json') {
      res.set('Content-Disposition', `attachment; filename="${name}.json"`);
      return res.json(regs);
    }
    const table = buildTable(regs, layout);
    if (format === 'xlsx') {
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}.xlsx"`,
      });
      return res.send(await toXlsx(table, layout === 'participants' ? 'Participants' : 'Teams'));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` });
    res.send(toCsv(table));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Bank statement reconciliation. The statement is read in memory and never stored.
// ---------------------------------------------------------------------------
const pendingRegs = db.prepare(`
  SELECT r.id, r.code, r.team_name, r.utr, r.amount, e.title AS event_title
  FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.status = 'pending' ORDER BY r.id
`);

router.post('/reconcile', express.json({ limit: Math.ceil(MAX_STATEMENT_BYTES * 1.4) + 200 * 1024 }), async (req, res, next) => {
  const kind = req.body?.kind === 'xlsx' ? 'xlsx' : 'text';
  const content = req.body?.content;
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'The statement is empty.' });

  const raw = kind === 'xlsx' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  if (raw.length > MAX_STATEMENT_BYTES) {
    return res.status(413).json({ error: `That statement is too large. The limit is ${limits.statementMb} MB. Export a shorter date range.` });
  }
  if (kind === 'xlsx' && !(raw[0] === 0x50 && raw[1] === 0x4b)) {
    return res.status(400).json({ error: 'Could not read that file. Use an .xlsx or .csv statement, or paste the statement text.' });
  }
  try {
    await scanOrThrow(raw, 'bank statement');
  } catch (err) {
    if (!(err instanceof UploadError)) return next(err);
    if (err.signature) audit(req.admin.username, 'upload.blocked', `statement, ${err.signature}`);
    return res.status(err.status).json({ error: err.message });
  }
  let rows;
  try {
    rows = await statementRows(kind, content);
  } catch {
    return res.status(400).json({ error: 'Could not read that file. Use an .xlsx or .csv statement, or paste the statement text.' });
  }
  const result = matchStatement(rows, pendingRegs.all());
  audit(req.admin.username, 'reconcile', `${result.rowsScanned} rows, ${result.results.filter((r) => r.found).length} matched`);
  res.json(result);
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
const allEvents = db.prepare(`
  SELECT e.*,
    (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'pending')  AS pending,
    (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'approved') AS approved,
    (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'rejected') AS rejected,
    (SELECT COALESCE(SUM(member_count), 0) FROM registrations r WHERE r.event_id = e.id AND r.status != 'rejected') AS participants
  FROM events e WHERE e.archived = 0 ORDER BY e.sort, e.id
`);
const eventById = db.prepare('SELECT * FROM events WHERE id = ? AND archived = 0');
const eventRegCount = db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?');

function listEventsJson() {
  return allEvents.all().map((row) => ({
    ...eventToJson(row), pending: row.pending, approved: row.approved, rejected: row.rejected, participants: row.participants,
  }));
}

function readEvent(body) {
  const title = clean(body?.title, 60);
  if (title.length < 2) return { error: 'Give the event a title.' };
  const teamBased = body?.teamBased === true;
  const minMembers = teamBased ? int(body?.minMembers, 1, 50, null) : 1;
  const maxMembers = teamBased ? int(body?.maxMembers, 1, 50, null) : 1;
  if (minMembers == null || maxMembers == null) return { error: 'Team size must be a whole number from 1 to 50.' };
  if (minMembers > maxMembers) return { error: 'Minimum team size cannot be more than the maximum.' };
  const maxTeams = int(body?.maxTeams, 0, 10000, null);
  if (maxTeams == null) return { error: 'The limit must be 0 (no limit) or a whole number.' };
  const fee = int(body?.fee, 0, 100000, null);
  if (fee == null) return { error: 'Fee must be a whole number of rupees.' };
  return {
    value: {
      title, description: clean(body?.description, 240), teamBased, minMembers, maxMembers, maxTeams, fee,
      isOpen: body?.isOpen !== false, sort: int(body?.sort, 0, 9999, 0),
    },
  };
}

router.get('/events', (req, res) => res.json({ events: listEventsJson() }));

router.post('/events', (req, res) => {
  const { error, value: v } = readEvent(req.body);
  if (error) return res.status(400).json({ error });
  db.prepare(`
    INSERT INTO events (title, description, team_based, min_members, max_members, max_teams, fee, is_open, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(v.title, v.description, v.teamBased ? 1 : 0, v.minMembers, v.maxMembers, v.maxTeams, v.fee, v.isOpen ? 1 : 0, v.sort);
  audit(req.admin.username, 'event.created', v.title);
  res.status(201).json({ events: listEventsJson() });
});

router.put('/events/:id', (req, res) => {
  const existing = eventById.get(int(req.params.id, 1, 1e9, 0));
  if (!existing) return res.status(404).json({ error: 'Event not found.' });
  const { error, value: v } = readEvent(req.body);
  if (error) return res.status(400).json({ error });
  db.prepare(`
    UPDATE events SET title = ?, description = ?, team_based = ?, min_members = ?, max_members = ?,
      max_teams = ?, fee = ?, is_open = ?, sort = ? WHERE id = ?
  `).run(v.title, v.description, v.teamBased ? 1 : 0, v.minMembers, v.maxMembers, v.maxTeams, v.fee, v.isOpen ? 1 : 0, v.sort, existing.id);
  audit(req.admin.username, 'event.updated', v.title);
  res.json({ events: listEventsJson() });
});

router.delete('/events/:id', (req, res) => {
  const existing = eventById.get(int(req.params.id, 1, 1e9, 0));
  if (!existing) return res.status(404).json({ error: 'Event not found.' });
  // Events that already have registrations are archived so the records stay intact.
  if (eventRegCount.get(existing.id).n > 0) db.prepare('UPDATE events SET archived = 1, is_open = 0 WHERE id = ?').run(existing.id);
  else db.prepare('DELETE FROM events WHERE id = ?').run(existing.id);
  audit(req.admin.username, 'event.removed', existing.title);
  res.json({ events: listEventsJson() });
});

// ---------------------------------------------------------------------------
// Student list (roster)
// ---------------------------------------------------------------------------
function rosterSummary() {
  const settings = getSettings();
  return {
    count: studentCount(),
    withPhone: db.prepare("SELECT COUNT(*) AS n FROM students WHERE phone != ''").get().n,
    withEmail: db.prepare("SELECT COUNT(*) AS n FROM students WHERE email != ''").get().n,
    rosterRequired: settings.rosterRequired,
    matchLeaderPhone: settings.matchLeaderPhone,
    emailVerification: settings.emailVerification,
    mail: { configured: mailConfigured, host: mailInfo.host, from: mailInfo.from, sentToday: mailsSentToday(), dailyLimit: mailInfo.dailyLimit },
  };
}

router.get('/students', (req, res) => {
  const q = clean(req.query.q, 40);
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const students = q
    ? db.prepare("SELECT * FROM students WHERE roll LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' ORDER BY roll LIMIT 200").all(like, like, like)
    : db.prepare('SELECT * FROM students ORDER BY roll LIMIT 200').all();
  res.json({ ...rosterSummary(), students });
});

router.post('/students/import', express.json({ limit: Math.ceil(MAX_STATEMENT_BYTES * 1.4) + 200 * 1024 }), async (req, res, next) => {
  const kind = req.body?.kind === 'xlsx' ? 'xlsx' : 'text';
  const mode = req.body?.mode === 'merge' ? 'merge' : 'replace';
  const content = req.body?.content;
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'The file is empty.' });
  const raw = kind === 'xlsx' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  if (raw.length > MAX_STATEMENT_BYTES) return res.status(413).json({ error: `That file is too large. The limit is ${limits.statementMb} MB.` });
  if (kind === 'xlsx' && !(raw[0] === 0x50 && raw[1] === 0x4b)) return res.status(400).json({ error: 'Could not read that file. Save it as .xlsx or .csv and try again.' });
  try {
    await scanOrThrow(raw, 'student list');
  } catch (err) {
    if (!(err instanceof UploadError)) return next(err);
    if (err.signature) audit(req.admin.username, 'upload.blocked', `student list, ${err.signature}`);
    return res.status(err.status).json({ error: err.message });
  }
  let rows;
  try {
    rows = await tableRows(kind, raw);
  } catch {
    return res.status(400).json({ error: 'Could not read that file. Save it as .xlsx or .csv and try again.' });
  }
  const { students, skipped, problems } = readRoster(rows);
  if (students.size === 0) {
    return res.status(400).json({ error: 'No students were found. The file needs a "Roll number" column and a "Name" column.', problems });
  }
  const total = importStudents(students, mode);
  audit(req.admin.username, 'students.imported', `${students.size} students (${mode}), ${skipped} rows skipped`);
  res.json({ imported: students.size, skipped, problems, ...rosterSummary(), total });
});

router.delete('/students/:roll', (req, res) => {
  const roll = normaliseRoll(req.params.roll);
  const result = db.prepare('DELETE FROM students WHERE roll = ?').run(roll);
  if (!result.changes) return res.status(404).json({ error: 'That roll number is not on the list.' });
  if (studentCount() === 0) saveSettings({ rosterRequired: false });
  audit(req.admin.username, 'students.removed', roll);
  res.json(rosterSummary());
});

router.delete('/students', (req, res) => {
  const removed = studentCount();
  db.exec('DELETE FROM students');
  saveSettings({ rosterRequired: false }); // an empty list would lock everyone out
  audit(req.admin.username, 'students.cleared', `${removed} students`);
  res.json(rosterSummary());
});

// Connects and logs in to the mail server without sending anything.
router.post('/mail/check', rateLimit({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res, next) => {
  try {
    await checkMailServer();
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof MailError) return res.status(502).json({ error: err.message });
    next(err);
  }
});

// Sends a test email so the organisers can confirm the SMTP settings before relying on them.
router.post('/mail/test', rateLimit({ windowMs: 10 * 60 * 1000, max: 10 }), async (req, res, next) => {
  const to = clean(req.body?.to, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return res.status(400).json({ error: 'Enter a valid email address to send the test to.' });
  if (!mailConfigured) return res.status(400).json({ error: 'Email is not set up yet. Add the SMTP settings to the .env file and restart.' });
  try {
    await sendMail(messages.test(to));
    audit(req.admin.username, 'mail.test', to);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof MailError) return res.status(502).json({ error: `${err.message} Check the SMTP host, port, username and password, then look at the app logs for the exact reason.` });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const isoOrEmpty = (value) => {
  if (!value) return '';
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

router.get('/settings', (req, res) => {
  const settings = getSettings();
  res.json({ settings, registration: registrationState(settings) });
});

router.put('/settings', (req, res) => {
  const b = req.body || {};
  const patch = {};

  if ('regMode' in b) {
    if (!['open', 'closed', 'scheduled'].includes(b.regMode)) return res.status(400).json({ error: 'Invalid registration mode.' });
    patch.regMode = b.regMode;
  }
  for (const key of ['opensAt', 'closesAt']) {
    if (key in b) {
      const iso = isoOrEmpty(b[key]);
      if (iso == null) return res.status(400).json({ error: 'Invalid date or time.' });
      patch[key] = iso;
    }
  }
  const merged = { ...getSettings(), ...patch };
  if (merged.regMode === 'scheduled') {
    if (!merged.opensAt && !merged.closesAt) return res.status(400).json({ error: 'Set an opening time, a closing time, or both.' });
    if (merged.opensAt && merged.closesAt && Date.parse(merged.opensAt) >= Date.parse(merged.closesAt)) {
      return res.status(400).json({ error: 'The closing time must be after the opening time.' });
    }
  }
  if ('upiId' in b) {
    const upiId = clean(b.upiId, 80);
    if (upiId && !/^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$/.test(upiId)) return res.status(400).json({ error: 'That does not look like a UPI ID (example: name@bank).' });
    patch.upiId = upiId;
  }
  if ('upiName' in b) patch.upiName = clean(b.upiName, 60) || 'Ideathon 26';
  if ('eventName' in b) patch.eventName = clean(b.eventName, 60) || "Ideathon '26";
  if ('venue' in b) patch.venue = clean(b.venue, 120);
  if ('notice' in b) patch.notice = clean(b.notice, 240);
  if ('contactName' in b) patch.contactName = clean(b.contactName, 60);
  if ('contactPhone' in b) patch.contactPhone = clean(b.contactPhone, 20);
  if ('eventDate' in b) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.eventDate)) return res.status(400).json({ error: 'Invalid event date.' });
    patch.eventDate = b.eventDate;
  }
  if ('allowMultiEvent' in b) patch.allowMultiEvent = b.allowMultiEvent === true;
  if ('rosterRequired' in b) {
    if (b.rosterRequired === true && studentCount() === 0) return res.status(400).json({ error: 'Upload the student list first.' });
    patch.rosterRequired = b.rosterRequired === true;
  }
  if ('matchLeaderPhone' in b) patch.matchLeaderPhone = b.matchLeaderPhone === true;
  if ('emailVerification' in b) {
    if (b.emailVerification === true && !mailConfigured) {
      return res.status(400).json({ error: 'Email is not set up yet. Add the SMTP settings to the .env file and restart, then send a test email.' });
    }
    patch.emailVerification = b.emailVerification === true;
  }
  if ('branches' in b) {
    const branches = Array.isArray(b.branches) ? [...new Set(b.branches.map((x) => clean(x, 40)).filter(Boolean))].slice(0, 40) : [];
    if (!branches.length) return res.status(400).json({ error: 'Add at least one branch.' });
    patch.branches = branches;
  }

  saveSettings(patch);
  audit(req.admin.username, 'settings.updated', Object.keys(patch).join(', '));
  const settings = getSettings();
  res.json({ settings, registration: registrationState(settings) });
});

// ---------------------------------------------------------------------------
// Overview and activity log
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  const totals = db.prepare(`
    SELECT status, COUNT(*) AS teams, COALESCE(SUM(member_count), 0) AS participants, COALESCE(SUM(amount), 0) AS amount
    FROM registrations GROUP BY status
  `).all();
  const by = Object.fromEntries(totals.map((t) => [t.status, t]));
  const zero = { teams: 0, participants: 0, amount: 0 };
  const settings = getSettings();
  res.json({
    pending: by.pending || zero,
    approved: by.approved || zero,
    rejected: by.rejected || zero,
    events: listEventsJson(),
    registration: registrationState(settings),
    upiConfigured: !!settings.upiId,
    scanner: { configured: scannerConfigured, healthy: await scannerHealthy(), required: scanRequired },
    roster: { count: studentCount(), required: settings.rosterRequired, emailVerification: settings.emailVerification, mailConfigured },
    unscanned: db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE scan_status != 'clean'").get().n,
    limits,
  });
});

router.get('/audit', (req, res) => {
  res.json({ entries: db.prepare('SELECT at, actor, action, detail FROM audit ORDER BY id DESC LIMIT 300').all() });
});
