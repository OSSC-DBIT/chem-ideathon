import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { db, tx, getSettings, registrationState, eventToJson, UPLOAD_DIR } from './db.js';
import { rateLimit } from './security.js';
import { clean, cleanPhone, NAME_RE, ROLL_RE, PHONE_RE, EMAIL_RE, UTR_RE, SECTION_RE, newCode } from './rules.js';
import { MAX_SCREENSHOT_BYTES, UploadError, decodeImageDataUrl, sanitiseImage, scanOrThrow, limits } from './uploads.js';
import { audit } from './db.js';
import { createCaptcha, verifyCaptcha } from './captcha.js';
import { sealFile } from './vault.js';
import { getStudent, maskEmail, maskName, tidySection } from './roster.js';
import { mailConfigured, sendMailLater, messages } from './mailer.js';
import { sendCode, checkCode, tokenValid, useToken, hasLiveChallenge, VerifyError } from './verify.js';

export const router = express.Router();

const NOT_LISTED = 'This roll number is not in the 1st year student list. Check it, or contact the coordinator.';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
const listEvents = db.prepare(`
  SELECT e.*, (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status != 'rejected') AS taken
  FROM events e WHERE e.archived = 0 ORDER BY e.sort, e.id
`);
const getEvent = db.prepare('SELECT * FROM events WHERE id = ? AND archived = 0');
const countTaken = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status != 'rejected'");
const teamNameTaken = db.prepare(
  "SELECT 1 FROM registrations WHERE event_id = ? AND status != 'rejected' AND team_name = ? COLLATE NOCASE",
);
const utrTaken = db.prepare(`
  SELECT id, code, event_id, leader_phone, member_count, amount, status, team_name
  FROM registrations WHERE utr = ? AND status != 'rejected'
`);
const leaderRoll = db.prepare('SELECT roll FROM members WHERE registration_id = ? AND position = 0');
const rollInEvent = db.prepare(`
  SELECT m.roll FROM members m JOIN registrations r ON r.id = m.registration_id
  WHERE r.status != 'rejected' AND r.event_id = ? AND m.roll = ?
`);
const rollAnywhere = db.prepare(`
  SELECT e.title FROM members m
  JOIN registrations r ON r.id = m.registration_id
  JOIN events e ON e.id = r.event_id
  WHERE r.status != 'rejected' AND m.roll = ?
`);
const insertReg = db.prepare(`
  INSERT INTO registrations (code, event_id, team_name, leader_email, leader_phone, member_count, amount, utr, screenshot, created_at, scan_status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertMember = db.prepare(
  'INSERT INTO members (registration_id, position, name, roll, branch, phone, section) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const findStatus = db.prepare(`
  SELECT r.code, r.team_name, r.member_count, r.amount, r.status, r.reject_reason, r.created_at, e.title AS event_title
  FROM registrations r JOIN events e ON e.id = r.event_id
  WHERE r.code = ? AND r.leader_phone = ?
`);

// ---------------------------------------------------------------------------
// Public info
// ---------------------------------------------------------------------------
router.get('/public', (req, res) => {
  const settings = getSettings();
  res.set('Cache-Control', 'no-store');
  res.json({
    eventName: settings.eventName,
    eventDate: settings.eventDate,
    venue: settings.venue,
    notice: settings.notice,
    allowMultiEvent: settings.allowMultiEvent,
    rosterRequired: settings.rosterRequired,
    emailVerification: settings.emailVerification && mailConfigured,
    maxScreenshotMb: limits.screenshotMb,
    branches: settings.branches,
    sections: settings.sections,
    allowOtherSection: settings.allowOtherSection,
    contactName: settings.contactName,
    contactPhone: settings.contactPhone,
    registration: registrationState(settings),
    events: listEvents.all().map((row) => {
      const ev = eventToJson(row);
      const full = ev.maxTeams > 0 && row.taken >= ev.maxTeams;
      return {
        id: ev.id, title: ev.title, description: ev.description, teamBased: ev.teamBased,
        minMembers: ev.minMembers, maxMembers: ev.maxMembers, maxTeams: ev.maxTeams, fee: ev.fee,
        isOpen: ev.isOpen, taken: row.taken, full,
      };
    }),
  });
});

// UPI QR for an exact amount. Cached per (UPI id, amount).
const qrCache = new Map();
router.get('/qr', async (req, res, next) => {
  try {
    const settings = getSettings();
    const amount = Number(req.query.amount);
    if (!settings.upiId) return res.status(503).json({ error: 'Payment details are not set up yet.' });
    if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return res.status(400).json({ error: 'Invalid amount.' });

    const key = `${settings.upiId}|${settings.upiName}|${amount}`;
    if (!qrCache.has(key)) {
      if (qrCache.size > 500) qrCache.clear();
      const upiLink =
        `upi://pay?pa=${encodeURIComponent(settings.upiId)}&pn=${encodeURIComponent(settings.upiName)}` +
        `&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent('Ideathon 26')}`;
      qrCache.set(key, { upiLink, qr: await QRCode.toDataURL(upiLink, { margin: 2, width: 420 }) });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ ...qrCache.get(key), upiId: settings.upiId, payee: settings.upiName, amount });
  } catch (err) {
    next(err);
  }
});

// A fresh captcha image. Each one works for a single submit attempt.
router.get('/captcha', rateLimit({ windowMs: 10 * 60 * 1000, max: 300 }), async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await createCaptcha());
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
function validate(body, event, settings) {
  const errors = {};
  const rawMembers = Array.isArray(body.members) ? body.members.slice(0, 50) : [];

  if (rawMembers.length < event.min_members || rawMembers.length > event.max_members) {
    errors.members = event.min_members === event.max_members
      ? `This event needs exactly ${event.min_members} participant(s).`
      : `A team needs ${event.min_members} to ${event.max_members} members.`;
  }

  const seen = new Set();
  const members = rawMembers.map((raw, i) => {
    const m = {
      name: clean(raw?.name, 60),
      roll: clean(raw?.roll, 20).toUpperCase().replace(/\s/g, ''),
      branch: clean(raw?.branch, 40),
      phone: cleanPhone(raw?.phone),
      section: tidySection(raw?.section),
    };
    let listed = null;
    if (!ROLL_RE.test(m.roll)) errors[`m${i}-roll`] = 'Enter a valid roll number.';
    else if (seen.has(m.roll)) errors[`m${i}-roll`] = 'This roll number is repeated in your team.';
    else if (settings.rosterRequired) {
      listed = getStudent(m.roll);
      if (!listed) errors[`m${i}-roll`] = NOT_LISTED;
    }
    seen.add(m.roll);
    if (settings.rosterRequired) {
      // Whatever the browser sent is ignored: the student list is the source of truth.
      m.name = listed ? listed.name : '';
      m.branch = listed ? listed.branch : '';
    } else {
      if (!NAME_RE.test(m.name)) errors[`m${i}-name`] = 'Enter the full name (letters only).';
      if (!settings.branches.includes(m.branch)) errors[`m${i}-branch`] = 'Select a branch.';
    }
    // Section: the student list wins when it has one; otherwise the student picks from the organisers' list.
    if (listed?.section) {
      m.section = listed.section;
    } else if (!settings.sections.includes(m.section)) {
      // Not one of the listed sections: fine when "Other" is allowed and something sensible was typed.
      const typed = settings.allowOtherSection && SECTION_RE.test(m.section);
      if (!typed) {
        errors[`m${i}-section`] = settings.allowOtherSection
          ? 'Select the section, or choose Other and type it (letters and digits only).'
          : 'Select the section.';
      }
    }
    if (i === 0 && listed && settings.matchLeaderPhone && listed.phone && PHONE_RE.test(m.phone) && listed.phone !== m.phone) {
      errors['m0-phone'] = 'This phone number does not match the one the college has for this roll number.';
    }
    if (i === 0 || m.phone) {
      if (!PHONE_RE.test(m.phone)) errors[`m${i}-phone`] = 'Enter a valid 10 digit mobile number.';
    }
    return m;
  });

  let email = clean(body.email, 120).toLowerCase();
  const leaderListed = settings.rosterRequired && members[0] ? getStudent(members[0].roll) : null;
  if (leaderListed?.email) email = leaderListed.email; // the student list wins over whatever was typed
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';

  let teamName = clean(body.teamName, 40);
  if (event.team_based) {
    if (teamName.length < 2) errors.teamName = 'Enter a team name.';
  } else {
    teamName = members[0]?.name || '';
  }

  const utr = clean(body.utr, 30).replace(/\s/g, '');
  if (!UTR_RE.test(utr)) errors.utr = 'Enter the 12 digit UPI transaction ID (UTR).';

  // Cheap checks only (type, size, file signature). The full decode and virus scan come later.
  let shot = null;
  try {
    shot = decodeImageDataUrl(body.screenshot);
  } catch (err) {
    errors.screenshot = err.message;
  }

  if (body.consentPrivacy !== true) errors.consentPrivacy = 'You need to accept the privacy policy.';
  if (body.consentFirstYear !== true) errors.consentFirstYear = 'Please confirm this.';

  return { errors, data: { members, email, teamName, utr, shot } };
}

/**
 * The rules that can clash with existing registrations: event capacity, team name,
 * and roll numbers that are already in a pending or approved registration.
 * Returns null when everything is free, otherwise { message, fields }.
 */
function findConflict(event, settings, teamName, rolls) {
  if (event.max_teams > 0 && countTaken.get(event.id).n >= event.max_teams) {
    return { message: `Sorry, ${event.title} is full.`, fields: { event: `${event.title} is full. Pick another event.` } };
  }
  const fields = {};
  const nameTaken = event.team_based && teamName && teamNameTaken.get(event.id, teamName);
  if (nameTaken) fields.teamName = 'This team name is taken. Pick another.';
  rolls.forEach((roll, i) => {
    if (!roll) return;
    const clash = settings.allowMultiEvent ? rollInEvent.get(event.id, roll) : rollAnywhere.get(roll);
    if (!clash) return;
    const who = i === 0 ? 'You are' : 'This student is';
    fields[`m${i}-roll`] = settings.allowMultiEvent
      ? `${who} already registered for this event in another team.`
      : `${who} already registered for ${clash.title}. A student can join only one event.`;
  });
  const count = Object.keys(fields).length - (nameTaken ? 1 : 0);
  if (count === 0 && nameTaken) return { message: 'That team name is already taken for this event.', fields };
  if (count > 0) {
    return {
      message: settings.allowMultiEvent
        ? `${count} of your members ${count === 1 ? 'is' : 'are'} already registered for this event. A student cannot be in two teams.`
        : `${count} of your members ${count === 1 ? 'is' : 'are'} already registered. A student can join only one event and one team. Replace them or ask the organisers.`,
      fields,
    };
  }
  return null;
}

/** Is this submission the same registration that already holds this transaction ID? */
function isSameRegistration(prior, event, data) {
  return prior.event_id === event.id && prior.leader_phone === data.members[0].phone &&
    prior.member_count === data.members.length && leaderRoll.get(prior.id)?.roll === data.members[0].roll;
}

class Conflict extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.fields = fields;
  }
}

router.post(
  '/register',
  express.json({ limit: Math.ceil(MAX_SCREENSHOT_BYTES * 1.4) + 200 * 1024 }),
  rateLimit({ windowMs: 10 * 60 * 1000, max: Number(process.env.REGISTER_RATE_LIMIT) || 40 }),
  async (req, res, next) => {
    const settings = getSettings();
    const state = registrationState(settings);
    if (state.state !== 'open') return res.status(403).json({ error: state.message });

    const body = req.body || {};
    const event = getEvent.get(Number(body.eventId) || 0);
    if (!event) return res.status(400).json({ error: 'Pick an event.', fields: { event: 'Pick an event.' } });
    if (!event.is_open) return res.status(403).json({ error: `Registrations for ${event.title} are closed.` });

    const { errors, data } = validate(body, event, settings);
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'Some details need fixing. Check the highlighted fields.', fields: errors });
    }

    // A transaction ID that is already registered is settled right here, before the captcha,
    // the virus scan or any image work. The very same registration sent again (double tap, or a
    // retry after the connection dropped) gets the original answer; anything else is refused.
    // Nothing costly can be triggered by reusing a known transaction ID.
    const prior = utrTaken.get(data.utr);
    if (prior) {
      if (!isSameRegistration(prior, event, data)) {
        return res.status(409).json({
          error: 'This transaction ID has already been used.',
          fields: { utr: 'This transaction ID is already used for another registration.' },
        });
      }
      return res.status(200).json({
        code: prior.code, eventTitle: event.title, teamName: prior.team_name, teamBased: !!event.team_based,
        memberCount: prior.member_count, amount: prior.amount, status: prior.status,
      });
    }

    // Tell people about clashes before spending their captcha (the same check runs again inside the transaction).
    const early = findConflict(event, settings, data.teamName, data.members.map((m) => m.roll));
    if (early) return res.status(409).json({ error: early.message, fields: early.fields });

    const mustVerifyEmail = settings.emailVerification && mailConfigured;
    if (mustVerifyEmail) {
      // The leader proved they own this email (and solved a captcha to get the code).
      if (!tokenValid(body.verifyToken, data.members[0].roll, data.email)) {
        const message = "Verify the team leader's email first. The verification may have expired, or the leader's details were changed after verifying.";
        return res.status(400).json({ error: message, fields: { email: 'This email needs to be verified.' }, verify: 'required' });
      }
    } else {
      // Captcha: one attempt per image. Checked before any expensive work is done.
      const captcha = verifyCaptcha(body.captchaId, typeof body.captchaAnswer === 'string' ? body.captchaAnswer : '');
      if (captcha !== 'ok') {
        const message = captcha === 'wrong' ? 'Those digits did not match. Try the new image.' : 'That security check has expired. Enter the new digits.';
        return res.status(400).json({ error: message, fields: { captcha: message }, captcha: 'retry' });
      }
    }

    // Virus scan the upload exactly as received, then decode it and keep only a re-encoded JPEG.
    let image;
    let scanStatus;
    try {
      scanStatus = await scanOrThrow(data.shot, 'payment screenshot');
      image = await sanitiseImage(data.shot);
    } catch (err) {
      if (!(err instanceof UploadError)) return next(err);
      if (err.signature) audit('system', 'upload.blocked', `screenshot, ${err.signature}, ip ${req.ip}`);
      return res.status(err.status).json({ error: err.message, fields: { screenshot: err.message } });
    }

    const fileName = `${crypto.randomBytes(16).toString('hex')}.jpg`;
    const filePath = path.join(UPLOAD_DIR, fileName);
    const amount = event.fee * data.members.length;

    try {
      const saved = tx(() => {
        // A resubmit of the very same registration (double tap, or a retry after the
        // connection dropped) returns the original instead of an error.
        // Checked again inside the transaction, in case two requests raced past the first check.
        const racing = utrTaken.get(data.utr);
        if (racing) {
          if (isSameRegistration(racing, event, data)) return { code: racing.code, status: racing.status, teamName: racing.team_name, replay: true };
          throw new Conflict('This transaction ID has already been used.', { utr: 'This transaction ID is already used for another registration.' });
        }
        const conflict = findConflict(event, settings, data.teamName, data.members.map((m) => m.roll));
        if (conflict) throw new Conflict(conflict.message, conflict.fields);

        fs.writeFileSync(filePath, sealFile(image), { mode: 0o600 }); // encrypted on disk
        const regCode = newCode();
        const result = insertReg.run(
          regCode, event.id, data.teamName, data.email, data.members[0].phone,
          data.members.length, amount, data.utr, fileName, new Date().toISOString(), scanStatus,
        );
        const regId = Number(result.lastInsertRowid);
        data.members.forEach((m, i) => insertMember.run(regId, i, m.name, m.roll, m.branch, m.phone, m.section));
        return { code: regCode, status: 'pending', teamName: data.teamName, replay: false };
      });

      if (!saved.replay) {
        if (mustVerifyEmail) useToken(body.verifyToken);
        sendMailLater(messages.received(data.email, {
          code: saved.code, eventTitle: event.title, teamName: data.teamName, teamBased: !!event.team_based,
          memberCount: data.members.length, amount,
        }));
      }

      res.status(saved.replay ? 200 : 201).json({
        code: saved.code,
        eventTitle: event.title,
        teamName: saved.teamName,
        teamBased: !!event.team_based,
        memberCount: data.members.length,
        amount,
        status: saved.status,
      });
    } catch (err) {
      fs.rm(filePath, { force: true }, () => {});
      if (err instanceof Conflict) return res.status(409).json({ error: err.message, fields: err.fields });
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Pre-payment check: same clash rules as the final submit, run before anyone pays.
// ---------------------------------------------------------------------------
router.post(
  '/precheck',
  express.json({ limit: '20kb' }),
  rateLimit({ windowMs: 10 * 60 * 1000, max: 900 }),
  (req, res) => {
    const settings = getSettings();
    const state = registrationState(settings);
    if (state.state !== 'open') return res.status(403).json({ error: state.message });
    const event = getEvent.get(Number(req.body?.eventId) || 0);
    if (!event) return res.status(400).json({ error: 'That event is no longer available. Pick another.', fields: { event: 'Pick an event.' } });
    if (!event.is_open) return res.status(403).json({ error: `Registrations for ${event.title} are closed.`, fields: { event: `${event.title} is closed. Pick another event.` } });

    const rolls = (Array.isArray(req.body?.rolls) ? req.body.rolls.slice(0, 50) : [])
      .map((r) => clean(r, 20).toUpperCase().replace(/\s/g, ''))
      .map((r) => (ROLL_RE.test(r) ? r : ''));
    // The same roll number entered for two members of this team.
    const repeated = {};
    const seenRolls = new Set();
    rolls.forEach((roll, i) => {
      if (!roll) return;
      if (seenRolls.has(roll)) repeated[`m${i}-roll`] = 'This roll number is repeated in your team. Each member needs their own roll number.';
      seenRolls.add(roll);
    });

    // With the student list on: report unknown roll numbers and send back the names to fill in.
    let students = null;
    const unknown = {};
    if (settings.rosterRequired) {
      students = rolls.map((roll, i) => {
        if (!roll || repeated[`m${i}-roll`]) return null; // a repeated row gets no name, so it cannot look accepted
        const s = getStudent(roll);
        if (!s) { unknown[`m${i}-roll`] = NOT_LISTED; return null; }
        // Only a masked email goes back to the browser, and only for the leader's own row.
        // Names and emails leave the server masked. The real values are filled in from the list at submit.
        const shown = { name: maskName(s.name), branch: s.branch, section: s.section };
        return i === 0 && s.email ? { ...shown, email: maskEmail(s.email) } : shown;
      });
    }
    const conflict = findConflict(event, settings, clean(req.body?.teamName, 40), rolls);
    const fields = { ...(conflict?.fields || {}), ...unknown, ...repeated };
    if (Object.keys(fields).length) {
      const error = Object.keys(repeated).length
        ? 'The same roll number is entered more than once in your team.'
        : Object.keys(unknown).length
          ? 'One or more roll numbers are not in the 1st year student list.'
          : conflict.message;
      return res.status(409).json({ error, fields, students });
    }
    res.json({ ok: true, students });
  },
);

// ---------------------------------------------------------------------------
// Email verification for the team leader
// ---------------------------------------------------------------------------
/** Which email belongs to this leader: the one on the student list when there is one, else the one typed. */
function leaderEmail(settings, body) {
  const roll = clean(body?.roll, 20).toUpperCase().replace(/\s/g, '');
  if (!ROLL_RE.test(roll)) throw new VerifyError("Enter the team leader's roll number first.");
  const listed = settings.rosterRequired ? getStudent(roll) : null;
  if (settings.rosterRequired && !listed) throw new VerifyError(NOT_LISTED);
  const email = listed?.email || clean(body?.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new VerifyError('Enter a valid email address for the team leader.');
  return { roll, email, fromList: !!listed?.email };
}

function verificationOn(req, res) {
  const settings = getSettings();
  const state = registrationState(settings);
  if (state.state !== 'open') { res.status(403).json({ error: state.message }); return null; }
  if (!settings.emailVerification || !mailConfigured) { res.status(400).json({ error: 'Email verification is not in use.' }); return null; }
  return settings;
}

const verifyFail = (res, err, next) => (err instanceof VerifyError
  ? res.status(err.status).json({ error: err.message, ...err.extra })
  : next(err));

router.post(
  '/verify/send',
  express.json({ limit: '10kb' }),
  rateLimit({ windowMs: 10 * 60 * 1000, max: Number(process.env.VERIFY_SEND_RATE_LIMIT) || 40, message: 'Too many verification emails were requested from your network. Wait 10 minutes and try again.' }),
  async (req, res, next) => {
    const settings = verificationOn(req, res);
    if (!settings) return;
    try {
      const { roll, email, fromList } = leaderEmail(settings, req.body);
      // Starting a verification needs a captcha, so the form cannot be used to flood inboxes.
      // A resend of a code that is still live does not (it has its own wait and cap).
      if (!hasLiveChallenge(roll, email)) {
        const captcha = verifyCaptcha(req.body?.captchaId, typeof req.body?.captchaAnswer === 'string' ? req.body.captchaAnswer : '');
        if (captcha !== 'ok') {
          const message = captcha === 'wrong' ? 'Those digits did not match. Try the new image.' : 'Type the digits from the image to get a code.';
          return res.status(400).json({ error: message, captcha: 'retry' });
        }
      }
      const sent = await sendCode(roll, email);
      res.json({ sentTo: fromList ? maskEmail(email) : email, ...sent });
    } catch (err) {
      verifyFail(res, err, next);
    }
  },
);

router.post(
  '/verify/check',
  express.json({ limit: '10kb' }),
  rateLimit({ windowMs: 10 * 60 * 1000, max: 120 }),
  (req, res, next) => {
    const settings = verificationOn(req, res);
    if (!settings) return;
    try {
      const { roll, email } = leaderEmail(settings, req.body);
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      if (!/^\d{6}$/.test(code.trim())) throw new VerifyError('Enter the 6 digit code from the email.');
      res.json(checkCode(roll, email, code.trim()));
    } catch (err) {
      verifyFail(res, err, next);
    }
  },
);

// ---------------------------------------------------------------------------
// Status lookup: needs both the registration ID and the leader's phone number.
// ---------------------------------------------------------------------------
router.post(
  '/status',
  express.json({ limit: '10kb' }),
  rateLimit({ windowMs: 10 * 60 * 1000, max: 30 }),
  (req, res) => {
    const code = clean(req.body?.code, 20).toUpperCase();
    const phone = cleanPhone(req.body?.phone);
    const row = /^IDT26-[A-Z0-9]{6}$/.test(code) && PHONE_RE.test(phone) ? findStatus.get(code, phone) : null;
    if (!row) return res.status(404).json({ error: 'No registration found for that ID and phone number.' });
    res.json({
      code: row.code,
      eventTitle: row.event_title,
      teamName: row.team_name,
      memberCount: row.member_count,
      amount: row.amount,
      status: row.status,
      rejectReason: row.reject_reason,
      createdAt: row.created_at,
    });
  },
);
