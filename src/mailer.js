import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Images shown in every email. They are attached to the message itself (referenced by "cid:"),
// so they appear without the mail app having to download anything from the internet.
const IMG_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public', 'img');
const INLINE_IMAGES = [
  { filename: 'ideathon-26.jpg', path: path.join(IMG_DIR, 'mail-banner.jpg'), cid: 'banner@ideathon' },
  { filename: 'ossc.jpg', path: path.join(IMG_DIR, 'mail-ossc.jpg'), cid: 'ossc@ideathon' },
].filter((image) => fs.existsSync(image.path));

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
    else await (await getTransporter()).sendMail({ from: FROM, to, subject, text, html, attachments: html ? INLINE_IMAGES : [] });
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

const YEAR = new Date().getFullYear();
const RIGHTS = `\u00A9 ${YEAR} OSSC, Don Bosco Institute of Technology, Bengaluru. All rights reserved.`;
const SIGN_OFF = `Ideathon '26, Department of Chemistry, Don Bosco Institute of Technology, Bengaluru.
Built and maintained by OSSC (OpenSource Students Club), DBIT. https://webuildnow.in
This is an automated email; replies are not read.
${RIGHTS}`;

/** Plain text version of a message: the lines, an optional highlighted value, then the sign off. */
function plain(lines, highlight) {
  const body = highlight ? [lines[0], `    ${highlight}`, ...lines.slice(1)] : lines;
  return `${body.join('\n\n')}\n\n-- \n${SIGN_OFF}`;
}

/**
 * HTML email: Ideathon banner, a title, the first line, an optional highlighted box (code or
 * registration ID), the other lines, then the OSSC footer. Built with tables and inline styles,
 * which is what mail apps render reliably.
 */
function layout(title, lines, highlight) {
  const para = (line) => `<p style="margin:0 0 14px">${esc(line)}</p>`;
  const box = highlight
    ? `<p style="margin:6px 0 20px"><span style="display:inline-block;font-size:30px;font-weight:800;letter-spacing:6px;background:#ffe500;border:3px solid #202124;border-radius:10px;padding:12px 18px;color:#202124">${esc(highlight)}</span></p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#fff6d8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff6d8"><tr><td align="center" style="padding:20px 10px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:3px solid #202124;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#202124">
    <tr><td style="background:#202124;padding:18px 20px 14px;text-align:center">
      <p style="margin:0 0 10px;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#ffe500">Department of Chemistry, DBIT</p>
      <img src="cid:banner@ideathon" width="560" alt="Ideathon '26" style="display:block;width:100%;max-width:560px;height:auto;margin:0 auto;border:0;color:#ffe500;font-size:28px;font-weight:800">
    </td></tr>
    <tr><td style="padding:26px 26px 12px;font-size:16px;line-height:1.55">
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;color:#202124">${esc(title)}</h1>
      ${para(lines[0])}${box}${lines.slice(1).map(para).join('')}
    </td></tr>
    <tr><td style="padding:0 26px 22px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #202124"><tr>
        <td width="64" valign="middle" style="padding:16px 14px 0 0"><img src="cid:ossc@ideathon" width="56" height="56" alt="OSSC" style="display:block;width:56px;height:56px;border-radius:50%;border:2px solid #202124"></td>
        <td valign="middle" style="padding-top:16px;font-size:13px;line-height:1.5;color:#4a4636">
          <strong style="color:#202124">Built and maintained by OSSC</strong><br>
          OpenSource Students Club, Don Bosco Institute of Technology, Bengaluru<br>
          <a href="https://webuildnow.in" style="color:#202124">webuildnow.in</a>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#202124;padding:14px 20px;text-align:center;font-size:12px;line-height:1.5;color:#d9d5c3">
      ${esc(RIGHTS)}<br>This is an automated email; replies are not read.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
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
      text: plain(lines, code),
      html: layout('Your verification code', lines, code),
    };
  },
  received(to, r) {
    const lines = [
      `We have received your registration for ${r.eventTitle}${r.teamBased ? ` (team "${r.teamName}", ${r.memberCount} members)` : ''}. Your registration ID is:`,
      r.payMethod === 'cash'
        ? `Amount to pay in cash: Rs. ${r.amount}. ${r.cashNote || ''} You will get another email when the organisers have recorded your payment.`.replace(/\s+/g, ' ')
        : `Amount: Rs. ${r.amount}. The organisers will now verify your payment. You will get another email when it is confirmed.`,
      'Keep this ID. With the team leader\'s phone number, it lets you check your status on the site.',
    ];
    return { to, subject: `Ideathon '26: registration received (${r.code})`, text: plain(lines, r.code), html: layout('Registration received', lines, r.code) };
  },
  approved(to, r) {
    const lines = [
      `Your payment is ${r.payMethod === 'cash' ? 'received' : 'verified'} and your registration for ${r.eventTitle} is confirmed. Registration ID:`,
      'Show this ID at the registration desk on the event day. See you there.',
    ];
    return { to, subject: `Ideathon '26: you are confirmed (${r.code})`, text: plain(lines, r.code), html: layout('You are confirmed', lines, r.code) };
  },
  rejected(to, r) {
    const lines = [
      `Your registration ${r.code} for ${r.eventTitle} was not accepted.`,
      `Reason: ${r.reason}`,
      'You can register again on the site with the correct details. If you think this is a mistake, contact the event coordinator.',
    ];
    return { to, subject: `Ideathon '26: registration not accepted (${r.code})`, text: plain(lines), html: layout('Registration not accepted', lines) };
  },
  test(to) {
    const lines = ['This is a test email from the Ideathon \'26 registration site. If you can read it, outgoing email is working.'];
    return { to, subject: 'Ideathon \'26: test email', text: plain(lines), html: layout('Email is working', lines) };
  },
};

/** For previews and tests: the HTML of a message with the inline images pointed at real files. */
export function previewHtml(message) {
  return INLINE_IMAGES.reduce((html, image) => html.replaceAll(`cid:${image.cid}`, `file:///${image.path.replace(/\\/g, '/')}`), message.html);
}
