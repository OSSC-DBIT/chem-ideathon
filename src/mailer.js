import dns from 'node:dns/promises';
import fs from 'node:fs';
import nodemailer from 'nodemailer';

/*
 * Outgoing email over SMTP. Configure with:
 *   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_SECURE (true for port 465), MAIL_FROM
 * Without SMTP_HOST and MAIL_FROM, email features switch themselves off.
 */

const HOST = (process.env.SMTP_HOST || '').trim();
const PORT = Number(process.env.SMTP_PORT) || 587;
const USER = (process.env.SMTP_USER || '').trim();
const PASS = process.env.SMTP_PASS || '';
const FROM = (process.env.MAIL_FROM || USER).trim();
const DAILY_LIMIT = Number(process.env.MAIL_DAILY_LIMIT) || 400; // stay under the provider's quota

// Test hook: outside production, mails can be written to a file instead of being sent.
const TEST_FILE = process.env.NODE_ENV !== 'production' ? (process.env.MAIL_TEST_FILE || '') : '';

export const mailConfigured = !!TEST_FILE || (!!HOST && !!FROM);
export const mailInfo = { host: TEST_FILE ? 'test file' : HOST, from: FROM || 'test@localhost', dailyLimit: DAILY_LIMIT };

/*
 * The transport is created on first use. The mail server's name is resolved with the system
 * resolver (which honours /etc/hosts), because the mail library's own DNS lookup would skip a
 * name that Docker points at this machine (SMTP_ON_THIS_HOST). TLS still verifies the
 * certificate against the real name through `servername`.
 */
let transporter = null;
let transporterFor = '';
async function getTransporter() {
  const { address } = await dns.lookup(HOST);
  if (transporter && transporterFor === address) return transporter;
  if (transporter) transporter.close();
  transporterFor = address;
  transporter = nodemailer.createTransport({
    host: address,
    port: PORT,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : PORT === 465,
    auth: USER ? { user: USER, pass: PASS } : undefined,
    // Never send a login over an unencrypted connection: with credentials, STARTTLS is mandatory.
    requireTLS: !!USER && PORT !== 465,
    tls: { servername: HOST },
    pool: true,
    maxConnections: 2,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transporter;
}

/** Connects, starts TLS and logs in, without sending anything. Throws MailError with the reason. */
export async function checkMailServer() {
  if (TEST_FILE) return;
  if (!HOST) throw new MailError('Email is not set up on this site.');
  try {
    await (await getTransporter()).verify();
  } catch (err) {
    console.error(`mail: connection check failed (${err.code || err.name}): ${err.message}`);
    const reason = {
      EAUTH: 'the mail server rejected the username or password',
      ETIMEDOUT: 'the mail server did not answer (is the tunnel or mail server running, and is the port right?)',
      ECONNREFUSED: 'nothing is listening on that host and port',
      ESOCKET: 'the secure connection failed (the certificate may not match SMTP_HOST)',
      ENOTFOUND: 'the mail server name could not be found',
      EDNS: 'the mail server name could not be found',
    }[err.code] || 'the mail server could not be reached';
    throw new MailError(`Email is not working: ${reason}.`);
  }
}

let day = '';
let sentToday = 0;
function countForToday() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; sentToday = 0; }
  return sentToday;
}
export const mailsSentToday = () => countForToday();

export class MailError extends Error {}

/** Sends one email. Throws MailError with a message that is safe to show to people. */
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured) throw new MailError('Email is not set up on this site.');
  if (countForToday() >= DAILY_LIMIT) {
    console.error('mail: daily limit reached');
    throw new MailError('The site has sent too many emails today. Please contact the coordinator.');
  }
  try {
    if (TEST_FILE) fs.appendFileSync(TEST_FILE, `${JSON.stringify({ to, subject, text })}\n`);
    else await (await getTransporter()).sendMail({ from: FROM, to, subject, text, html });
    sentToday += 1;
  } catch (err) {
    console.error(`mail: sending failed (${err.code || err.name}): ${err.message}`);
    throw new MailError('The email could not be sent right now. Try again in a minute.');
  }
}

/** Fire and forget, for notices that must never hold up or fail a request. */
export function sendMailLater(message) {
  if (!mailConfigured || !message?.to) return;
  sendMail(message).catch(() => { /* already logged */ });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Simple HTML email: a title, the first line, an optional highlighted box (code or ID), then the other lines. */
function layout(title, lines, highlight) {
  const para = (line) => `<p style="margin:0 0 12px">${esc(line)}</p>`;
  const box = highlight
    ? `<p style="margin:18px 0;font-size:30px;font-weight:800;letter-spacing:6px;background:#ffe500;border:3px solid #202124;border-radius:10px;padding:12px 16px;display:inline-block">${esc(highlight)}</p>`
    : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#202124;max-width:520px;margin:0 auto;padding:20px;font-size:16px;line-height:1.5">
<h2 style="margin:0 0 14px">${esc(title)}</h2>${para(lines[0])}${box}${lines.slice(1).map(para).join('')}
<p style="margin:22px 0 0;font-size:13px;color:#666">Ideathon '26, Department of Chemistry, Don Bosco Institute of Technology, Bengaluru. Site maintained by OSSC. This is an automated email; replies are not read.</p></div>`;
}

export const messages = {
  code(to, code, minutes) {
    const lines = [
      'Use this code to verify your email for the Ideathon \'26 registration:',
      `It works for ${minutes} minutes and can be used once.`,
      'If you did not ask for this, someone may have typed your roll number by mistake. You can ignore this email; nothing happens without the code.',
    ];
    return {
      to,
      subject: `${code} is your Ideathon '26 verification code`,
      text: `${lines[0]}\n\n    ${code}\n\n${lines[1]}\n\n${lines[2]}`,
      html: layout('Your verification code', lines, code),
    };
  },
  received(to, r) {
    const lines = [
      `We have received your registration for ${r.eventTitle}${r.teamBased ? ` (team "${r.teamName}", ${r.memberCount} members)` : ''}. Your registration ID is:`,
      `Amount: Rs. ${r.amount}. The organisers will now verify your payment. You will get another email when it is confirmed.`,
      'Keep this ID. With the team leader\'s phone number, it lets you check your status on the site.',
    ];
    return { to, subject: `Ideathon '26: registration received (${r.code})`, text: `${lines[0]}\n\n    ${r.code}\n\n${lines[1]}\n\n${lines[2]}`, html: layout('Registration received', lines, r.code) };
  },
  approved(to, r) {
    const lines = [
      `Your payment is verified and your registration for ${r.eventTitle} is confirmed. Registration ID:`,
      'Show this ID at the registration desk on the event day. See you there.',
    ];
    return { to, subject: `Ideathon '26: you are confirmed (${r.code})`, text: `${lines[0]}\n\n    ${r.code}\n\n${lines[1]}`, html: layout('You are confirmed', lines, r.code) };
  },
  rejected(to, r) {
    const lines = [
      `Your registration ${r.code} for ${r.eventTitle} was not accepted.`,
      `Reason: ${r.reason}`,
      'You can register again on the site with the correct details. If you think this is a mistake, contact the event coordinator.',
    ];
    return { to, subject: `Ideathon '26: registration not accepted (${r.code})`, text: lines.join('\n\n'), html: layout('Registration not accepted', lines) };
  },
  test(to) {
    const lines = ['This is a test email from the Ideathon \'26 registration site. If you can read it, outgoing email is working.'];
    return { to, subject: 'Ideathon \'26: test email', text: lines[0], html: layout('Email is working', lines) };
  },
};
