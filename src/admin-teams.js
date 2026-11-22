import express from 'express';
import { db, tx, audit, getSettings } from './db.js';
import { clean, cleanPhone, cleanRoll, ROLL_RE, PHONE_RE, EMAIL_RE, UTR_RE } from './rules.js';
import { findClash, eventWithHalf, nextRegistrationId } from './participation.js';
import { getStudent, studentCount, tidySection } from './roster.js';
import { sendMailLater, messages } from './mailer.js';

/*
 * Admin tools for the things the public form does not allow:
 *
 *   - adding a registration by hand (a team that paid in cash, a late entry, a correction)
 *   - editing a team: add, remove or reorder members, change the leader, fix details
 *   - adding or editing a single student on the student list
 *
 * The clash rules are the same as for students (one student, one event; unique team name
 * and transaction ID), but an organiser may knowingly go outside the team size or the
 * event's limit after confirming. Everything is written to the activity log.
 *
 * The router is mounted under /api/admin after requireAdmin, so every route here needs
 * a signed in organiser and a CSRF token.
 */

export const router = express.Router();

const int = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

const eventById = db.prepare('SELECT * FROM events WHERE id = ?');
const regById = db.prepare('SELECT r.*, e.title AS event_title, e.slot AS event_slot FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.id = ?');
const membersOf = db.prepare('SELECT name, roll, branch, phone, section FROM members WHERE registration_id = ? ORDER BY position');
const liveCount = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status != 'rejected' AND id != ?");
const nameClash = db.prepare("SELECT code FROM registrations WHERE event_id = ? AND status != 'rejected' AND id != ? AND team_name = ? COLLATE NOCASE");
const utrClash = db.prepare("SELECT code, team_name FROM registrations WHERE utr = ? AND status != 'rejected' AND id != ?");
const insertMember = db.prepare('INSERT INTO members (registration_id, position, name, roll, branch, phone, section) VALUES (?, ?, ?, ?, ?, ?, ?)');

function toJson(row) {
  return {
    id: row.id, code: row.code, eventId: row.event_id, eventTitle: row.event_title, eventSlot: row.event_slot, teamName: row.team_name,
    leaderEmail: row.leader_email, leaderPhone: row.leader_phone, memberCount: row.member_count, amount: row.amount,
    utr: row.utr, payMethod: row.pay_method, status: row.status, rejectReason: row.reject_reason, decidedBy: row.decided_by, decidedAt: row.decided_at,
    createdAt: row.created_at, scanStatus: row.scan_status, source: row.source, note: row.note,
    hasScreenshot: !!row.screenshot, members: membersOf.all(row.id),
  };
}

/**
 * Checks a team sent from the admin panel. `selfId` is the registration being edited (0 for a new one),
 * so a team does not clash with itself.
 * Returns { errors, confirm, team }: `errors` must be fixed; `confirm` lists things the organiser may
 * knowingly accept (sent again with override: true).
 */
function readTeam(body, event, settings, selfId) {
  const errors = {};
  const confirm = [];
  const seen = new Set();
  const raw = Array.isArray(body?.members) ? body.members.slice(0, 60) : [];

  const members = raw.map((entry, i) => {
    const m = { name: clean(entry?.name, 60), roll: cleanRoll(entry?.roll), branch: clean(entry?.branch, 40), phone: cleanPhone(entry?.phone), section: tidySection(entry?.section) };
    const listed = ROLL_RE.test(m.roll) ? getStudent(m.roll) : null;

    if (!ROLL_RE.test(m.roll)) {
      errors[`m${i}-roll`] = 'Enter a valid ERP ID.';
    } else if (seen.has(m.roll)) {
      errors[`m${i}-roll`] = 'This ERP ID is repeated in the team.';
    } else if (settings.rosterRequired && !listed) {
      errors[`m${i}-roll`] = 'Not on the student list. Add the student under Student list first.';
    } else {
      const clash = findClash(settings, event, m.roll, selfId);
      if (clash) errors[`m${i}-roll`] = `Already in team "${clash.team_name}" (${clash.code}, ${eventWithHalf(clash.title, clash.slot)}). Remove them there first.`;
    }
    seen.add(m.roll);

    // The student list, when there is one, is the source of truth for the name and branch.
    if (listed) {
      m.name = listed.name;
      m.branch = listed.branch || m.branch;
      m.section = listed.section || m.section;
      if (!m.phone && listed.phone) m.phone = listed.phone;
    }
    if (m.name.length < 2) errors[`m${i}-name`] = 'Enter the name.';
    if (i === 0 || m.phone) {
      if (!PHONE_RE.test(m.phone)) errors[`m${i}-phone`] = i === 0 ? "Enter the leader's 10 digit mobile number." : 'Enter a valid 10 digit mobile number, or leave it empty.';
    }
    return m;
  });

  if (members.length === 0) errors.members = 'Add at least one participant.';
  else if (members.length < event.min_members || members.length > event.max_members) {
    const wanted = event.min_members === event.max_members ? `${event.min_members}` : `${event.min_members} to ${event.max_members}`;
    confirm.push(`This team will have ${members.length} member(s). ${event.title} normally needs ${wanted}.`);
  }

  let teamName = clean(body?.teamName, 40);
  if (event.team_based) {
    if (teamName.length < 2) errors.teamName = 'Enter a team name.';
    else {
      const clash = nameClash.get(event.id, selfId, teamName);
      if (clash) errors.teamName = `Another team in this event already uses this name (${clash.code}).`;
    }
  } else {
    teamName = members[0]?.name || '';
  }

  const leaderListed = members[0] && ROLL_RE.test(members[0].roll) ? getStudent(members[0].roll) : null;
  const leaderEmail = clean(body?.leaderEmail, 120).toLowerCase() || leaderListed?.email || '';
  if (!EMAIL_RE.test(leaderEmail)) errors.leaderEmail = "Enter the team leader's email address.";

  const utr = clean(body?.utr, 30).replace(/\s/g, '');
  if (utr) {
    if (!UTR_RE.test(utr)) errors.utr = 'A UPI transaction ID has 12 digits. Leave this empty if the team did not pay by UPI.';
    else {
      const clash = utrClash.get(utr, selfId);
      if (clash) errors.utr = `This transaction ID is already used by team "${clash.team_name}" (${clash.code}).`;
    }
  }

  return { errors, confirm, team: { members, teamName, leaderEmail, utr, note: clean(body?.note, 160) } };
}

/** Sends the standard "fix these" or "please confirm" reply. Returns true when a reply was sent. */
function refuse(res, body, errors, confirm) {
  if (Object.keys(errors).length) {
    res.status(400).json({ error: 'Some details need fixing. Check the highlighted fields.', fields: errors });
    return true;
  }
  if (confirm.length && body?.override !== true) {
    res.status(409).json({ error: confirm.join(' '), needsOverride: true });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Add a registration by hand
// ---------------------------------------------------------------------------
router.post('/registrations', (req, res) => {
  const body = req.body || {};
  const event = eventById.get(int(body.eventId, 1, 1e9, 0));
  if (!event || event.archived) return res.status(400).json({ error: 'Pick an event.', fields: { eventId: 'Pick an event.' } });
  const status = body.status === 'pending' ? 'pending' : 'approved';

  const { errors, confirm, team } = readTeam(body, event, getSettings(), 0);
  if (event.max_teams > 0 && liveCount.get(event.id, 0).n >= event.max_teams) {
    confirm.push(`${event.title} is already at its limit of ${event.max_teams}.`);
  }
  if (refuse(res, body, errors, confirm)) return;

  const now = new Date().toISOString();
  const amount = event.fee * team.members.length;
  const id = tx(() => {
    const result = db.prepare(`
      INSERT INTO registrations (code, event_id, team_name, leader_email, leader_phone, member_count, amount, utr,
        screenshot, status, decided_by, decided_at, created_at, scan_status, source, note, pay_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 'none', 'admin', ?, ?)
    `).run(nextRegistrationId(event.id), event.id, team.teamName, team.leaderEmail, team.members[0].phone, team.members.length, amount, team.utr,
      status, status === 'approved' ? req.admin.username : null, status === 'approved' ? now : null, now, team.note, team.utr ? 'upi' : 'cash');
    const regId = Number(result.lastInsertRowid);
    team.members.forEach((m, i) => insertMember.run(regId, i, m.name, m.roll, m.branch, m.phone, m.section));
    return regId;
  });

  const saved = toJson(regById.get(id));
  audit(req.admin.username, 'registration.added', `${saved.code} ${saved.teamName}, ${event.title}, ${saved.memberCount} member(s), ${status}${team.note ? ` | ${team.note}` : ''}`);
  if (status === 'approved') sendMailLater(messages.approved(saved.leaderEmail, { code: saved.code, eventTitle: event.title }));
  res.status(201).json({ registration: saved });
});

// ---------------------------------------------------------------------------
// Edit a team: members, leader, details
// ---------------------------------------------------------------------------
router.put('/registrations/:id', (req, res) => {
  const row = regById.get(int(req.params.id, 1, 1e9, 0));
  if (!row) return res.status(404).json({ error: 'Registration not found.' });
  if (row.status === 'rejected') {
    return res.status(409).json({ error: 'A rejected registration cannot be edited. Ask the team to register again, or add them by hand.' });
  }
  const event = eventById.get(row.event_id);
  const body = req.body || {};
  const { errors, confirm, team } = readTeam(body, event, getSettings(), row.id);
  if (refuse(res, body, errors, confirm)) return;

  const before = membersOf.all(row.id);
  const amount = event.fee * team.members.length;
  tx(() => {
    db.prepare(`
      UPDATE registrations SET team_name = ?, leader_email = ?, leader_phone = ?, member_count = ?, amount = ?, utr = ?, note = ?, pay_method = ?
      WHERE id = ?
    `).run(team.teamName, team.leaderEmail, team.members[0].phone, team.members.length, amount, team.utr, team.note, team.utr ? 'upi' : 'cash', row.id);
    db.prepare('DELETE FROM members WHERE registration_id = ?').run(row.id);
    team.members.forEach((m, i) => insertMember.run(row.id, i, m.name, m.roll, m.branch, m.phone, m.section));
  });

  // A readable summary of what changed, for the activity log.
  const was = new Set(before.map((m) => m.roll));
  const now = new Set(team.members.map((m) => m.roll));
  const changes = [];
  const added = team.members.filter((m) => !was.has(m.roll)).map((m) => m.roll);
  const removed = before.filter((m) => !now.has(m.roll)).map((m) => m.roll);
  if (added.length) changes.push(`added ${added.join(', ')}`);
  if (removed.length) changes.push(`removed ${removed.join(', ')}`);
  if (before[0]?.roll !== team.members[0].roll) changes.push(`leader is now ${team.members[0].roll}`);
  if (row.team_name !== team.teamName) changes.push(`team name "${row.team_name}" to "${team.teamName}"`);
  if (row.utr !== team.utr) changes.push('transaction ID changed');
  if (row.amount !== amount) changes.push(`amount ${row.amount} to ${amount}`);
  audit(req.admin.username, 'registration.edited', `${row.code}: ${changes.join('; ') || 'details updated'}`);

  res.json({ registration: toJson(regById.get(row.id)), amountBefore: row.amount });
});

// ---------------------------------------------------------------------------
// Single students on the student list
// ---------------------------------------------------------------------------
function readStudent(body) {
  const errors = {};
  const student = {
    name: clean(body?.name, 60),
    branch: clean(body?.branch, 40),
    section: tidySection(body?.section),
    phone: cleanPhone(body?.phone),
    email: clean(body?.email, 120).toLowerCase(),
  };
  if (student.name.length < 2) errors.name = 'Enter the name.';
  if (student.phone && !PHONE_RE.test(student.phone)) errors.phone = 'Enter a valid 10 digit mobile number, or leave it empty.';
  if (student.email && !EMAIL_RE.test(student.email)) errors.email = 'Enter a valid email address, or leave it empty.';
  return { errors, student };
}

const summary = () => ({ count: studentCount() });

/** Who the given ERP IDs belong to, with full details. For the team editor. */
router.post('/students/lookup', (req, res) => {
  const rolls = Array.isArray(req.body?.rolls) ? req.body.rolls.slice(0, 60) : [];
  const settings = getSettings();
  res.json({
    rosterRequired: settings.rosterRequired,
    students: rolls.map((raw) => {
      const roll = cleanRoll(raw);
      return ROLL_RE.test(roll) ? getStudent(roll) : null;
    }),
  });
});

router.post('/students', (req, res) => {
  const roll = cleanRoll(req.body?.roll);
  const { errors, student } = readStudent(req.body);
  if (!ROLL_RE.test(roll) || !/\d/.test(roll)) errors.roll = 'Enter a valid ERP ID (3 to 20 letters and digits).';
  else if (getStudent(roll)) errors.roll = 'This ERP ID is already on the list. Edit that student instead.';
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
  db.prepare('INSERT INTO students (roll, name, branch, phone, email, section) VALUES (?, ?, ?, ?, ?, ?)')
    .run(roll, student.name, student.branch, student.phone, student.email, student.section);
  audit(req.admin.username, 'student.added', roll);
  res.status(201).json({ student: getStudent(roll), ...summary() });
});

router.put('/students/:roll', (req, res) => {
  const roll = cleanRoll(req.params.roll);
  const existing = getStudent(roll);
  if (!existing) return res.status(404).json({ error: 'That ERP ID is not on the list.' });
  const { errors, student } = readStudent(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });

  // Registrations keep their own copy of each member's name, branch and section. Keep those in step,
  // so a corrected spelling shows up on attendance sheets too.
  const updated = tx(() => {
    db.prepare('UPDATE students SET name = ?, branch = ?, phone = ?, email = ?, section = ? WHERE roll = ?')
      .run(student.name, student.branch, student.phone, student.email, student.section, roll);
    const inTeams = db.prepare(`
      UPDATE members SET name = ?, branch = CASE WHEN ? != '' THEN ? ELSE branch END,
        section = CASE WHEN ? != '' THEN ? ELSE section END
      WHERE roll = ? AND registration_id IN (SELECT id FROM registrations WHERE status != 'rejected')
    `).run(student.name, student.branch, student.branch, student.section, student.section, roll).changes;
    // Solo entries use the participant's name as the team name.
    db.prepare(`
      UPDATE registrations SET team_name = ? WHERE status != 'rejected'
        AND event_id IN (SELECT id FROM events WHERE team_based = 0)
        AND id IN (SELECT registration_id FROM members WHERE roll = ? AND position = 0)
    `).run(student.name, roll);
    if (student.email && student.email !== existing.email) {
      db.prepare(`
        UPDATE registrations SET leader_email = ? WHERE status != 'rejected'
          AND id IN (SELECT registration_id FROM members WHERE roll = ? AND position = 0)
      `).run(student.email, roll);
    }
    return inTeams;
  });
  audit(req.admin.username, 'student.edited', `${roll}${updated ? `, also updated in ${updated} registration(s)` : ''}`);
  res.json({ student: getStudent(roll), registrationsUpdated: updated, ...summary() });
});
