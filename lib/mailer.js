'use strict';
// Sends email. Provider is chosen from environment variables:
//  1) Brevo over HTTPS  -> BREVO_API_KEY + MAIL_FROM   (works on Render's free tier)
//  2) Gmail over SMTP   -> GMAIL_USER + GMAIL_APP_PASSWORD  (needs a host that allows SMTP ports)
const tls = require('node:tls');
const net = require('node:net');

const config = () => ({
  brevoKey: process.env.BREVO_API_KEY || '',
  from: process.env.MAIL_FROM || process.env.GMAIL_USER || '',
  fromName: process.env.MAIL_FROM_NAME || 'Workwise',
  gmailUser: process.env.GMAIL_USER || '',
  gmailPass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')
});
function provider() {
  const c = config();
  if (c.brevoKey && c.from) return 'brevo';
  if (c.gmailUser && c.gmailPass) return 'smtp';
  return null;
}

async function sendBrevo(c, { to, subject, text }) {
  const base = process.env.BREVO_API_URL || 'https://api.brevo.com';
  const response = await fetch(`${base}/v3/smtp/email`, {
    method: 'POST',
    headers: { 'api-key': c.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: c.from, name: c.fromName }, to: [{ email: to }], subject, textContent: text })
  });
  if (!response.ok) throw new Error(`Email service replied ${response.status}`);
}

function sendSmtp(c, { to, subject, text }) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT) || 465;
    const secure = process.env.SMTP_SECURE !== 'false';
    const socket = (secure ? tls.connect : net.connect)({ host, port, servername: host });
    socket.setEncoding('utf8');
    const lines = []; let buffer = ''; let wake = null;
    const finish = error => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(15000, () => finish(new Error('SMTP connection timed out')));
    socket.on('error', finish);
    socket.on('data', chunk => {
      buffer += chunk; let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) { lines.push(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
      if (wake) { const w = wake; wake = null; w(); }
    });
    const reply = async () => {
      for (;;) {
        const end = lines.findIndex(line => /^\d{3} /.test(line));
        if (end >= 0) { const out = lines.splice(0, end + 1); return { code: Number(out[out.length - 1].slice(0, 3)), text: out.join(' | ') }; }
        await new Promise(resolveWake => { wake = resolveWake; });
      }
    };
    const step = async (line, ok) => {
      if (line !== null) socket.write(`${line}\r\n`);
      const r = await reply();
      if (!ok.includes(r.code)) throw new Error(`SMTP error: ${r.text.slice(0, 120)}`);
    };
    const b64 = value => Buffer.from(value, 'utf8').toString('base64');
    const header = value => /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
    (async () => {
      await step(null, [220]);
      await step('EHLO workwise.local', [250]);
      await step('AUTH LOGIN', [334]); await step(b64(c.gmailUser), [334]); await step(b64(c.gmailPass), [235]);
      await step(`MAIL FROM:<${c.from}>`, [250]); await step(`RCPT TO:<${to}>`, [250, 251]); await step('DATA', [354]);
      const message = [`From: ${header(c.fromName)} <${c.from}>`, `To: <${to}>`, `Subject: ${header(subject)}`, `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
        ...(b64(text).match(/.{1,76}/g) || [])].join('\r\n');
      await step(`${message}\r\n.`, [250]);
      socket.write('QUIT\r\n'); finish();
    })().catch(finish);
  });
}

async function sendMail(mail) {
  const kind = provider();
  if (!/^\S+@\S+\.\S+$/.test(mail.to)) throw new Error('Invalid recipient');
  if (kind === 'brevo') { await sendBrevo(config(), mail); return { delivered: true, provider: 'brevo' }; }
  if (kind === 'smtp') { await sendSmtp(config(), { ...mail }); return { delivered: true, provider: 'smtp' }; }
  console.log(`[mail not configured] To: ${mail.to} | ${mail.subject}\n${mail.text}\n`);   // development only
  return { delivered: false, provider: null };
}
module.exports = { sendMail, provider };
