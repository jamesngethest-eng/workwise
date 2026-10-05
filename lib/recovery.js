'use strict';
// Forgot-password: a 6-digit code is emailed, stored hashed in SQL, expires in 10 minutes, 5 tries max.
const crypto = require('node:crypto');
const TTL = 10 * 60_000, MAX_ATTEMPTS = 5, MIN_GAP = 3_000, MAX_PER_HOUR = 8;
const requests = new Map();   // email -> times of recent code requests (abuse limit, not a delay)
const hashCode = (code, salt) => crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');

async function handle(ctx) {
  const { method, pathname, request, send, database, sql, readJson, saveDatabase, passwordRecord, guard, mailer, ip } = ctx;
  if (method !== 'POST' || (pathname !== '/api/auth/forgot' && pathname !== '/api/auth/reset')) return false;
  const body = await readJson(request, 10_000);
  const email = String(body.email || '').trim().toLowerCase();

  if (pathname === '/api/auth/forgot') {
    const generic = { ok: true, message: 'If an account exists for that email, we have sent a 6-digit code. It expires in 10 minutes.' };
    const user = /^\S+@\S+\.\S+$/.test(email) && database.users.find(item => item.email === email);
    if (!user) return send(200, generic);                                   // same answer either way: no account enumeration
    const now = Date.now();
    const times = (requests.get(email) || []).filter(time => now - time < 3_600_000);
    if ((times.length && now - times[times.length - 1] < MIN_GAP) || times.length >= MAX_PER_HOUR) return send(200, generic);   // only stops double-clicks and floods
    requests.set(email, [...times, now]);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = crypto.randomBytes(8).toString('hex');
    sql.prepare('INSERT OR REPLACE INTO recovery_codes (email, code_hash, salt, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(email, hashCode(code, salt), salt, Date.now() + TTL, Date.now());
    guard.log('recovery', ip, `Recovery code requested for ${guard.mask(email)}`);
    mailer.sendMail({ to: email, subject: `${code} is your Workwise recovery code`, text: `Your Workwise account recovery code is ${code}\n\nIt expires in 10 minutes. If you did not ask for this, you can ignore this email. Your password has not been changed.` })
      .catch(error => console.error('Recovery email failed:', error.message));
    return send(200, generic);
  }

  const code = String(body.code || '').trim();
  const newPassword = String(body.newPassword || '');
  const fail = () => send(400, { error: 'That code is incorrect or has expired. Request a new one and try again.' });
  const user = database.users.find(item => item.email === email);
  const row = user && sql.prepare('SELECT * FROM recovery_codes WHERE email = ?').get(email);
  if (!row) return fail();
  if (row.expires_at < Date.now() || row.attempts >= MAX_ATTEMPTS) { sql.prepare('DELETE FROM recovery_codes WHERE email = ?').run(email); return fail(); }
  const minimum = user.role === 'admin' ? 10 : 8;
  if (newPassword.length < minimum) return send(400, { error: `Choose a new password with at least ${minimum} characters.` });
  const supplied = Buffer.from(hashCode(code, row.salt), 'hex'), stored = Buffer.from(row.code_hash, 'hex');
  if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(supplied, stored)) {
    sql.prepare('UPDATE recovery_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
    guard.log('recovery-failed', ip, `Wrong recovery code for ${guard.mask(email)}`);
    return fail();
  }
  const credentials = await passwordRecord(newPassword);
  user.salt = credentials.salt; user.hash = credentials.hash;
  database.sessions = database.sessions.filter(session => session.userId !== user.id);   // sign out everywhere
  saveDatabase();
  sql.prepare('DELETE FROM recovery_codes WHERE email = ?').run(email);
  guard.loginOk(email, ip);
  guard.log('password-reset', ip, `Password reset for ${guard.mask(email)}`);
  mailer.sendMail({ to: email, subject: 'Your Workwise password was changed', text: 'Your Workwise password was just changed using a recovery code. If this was not you, contact the site administrator immediately.' }).catch(() => {});
  return send(200, { ok: true, message: 'Password updated. You can now sign in with your new password.' });
}
module.exports = { handle };
