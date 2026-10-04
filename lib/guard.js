'use strict';
// Application-level firewall: security headers, scanner/honeypot blocking, rate limiting,
// brute-force lockout, CSRF origin check, and a persistent IP block list (SQL).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIN = 60_000;
const isProd = process.env.NODE_ENV === 'production';
const trustProxy = process.env.TRUST_PROXY ? process.env.TRUST_PROXY !== 'false' : isProd;
const strict = process.env.GUARD_STRICT === 'true';           // also guard loopback (used for testing)
const PROBE_BLOCK = Number(process.env.PROBE_BLOCK_MINUTES || 60) * MIN;
const MAX_BODY = 110 * 1024 * 1024;

let sql = null;
const blocked = new Map(), buckets = new Map(), strikes = new Map(), failed = new Map();
const recent = [];

const PROBE = /(^|\/)(\.env|\.git|\.svn|\.ds_store|\.htaccess|\.htpasswd|wp-admin|wp-login|wp-content|wp-includes|xmlrpc|phpmyadmin|pma|cgi-bin|actuator|boaform|server-status|server\.js|start-server\.js|package(-lock)?\.json|render\.yaml|database\.json|workwise\.sqlite|lib\/|\.workwise-data|etc\/passwd|node_modules)|\.(php\d?|asp|aspx|jsp|cgi|sql|bak|ini|log|sqlite)(\?|$)|\.\.\/|\.\.\\|%00/i;

function init(db) {
  sql = db;
  if (!sql) return;
  sql.prepare('DELETE FROM blocked_ips WHERE until < ?').run(Date.now());
  for (const row of sql.prepare('SELECT ip, until, reason, created_at FROM blocked_ips').all()) blocked.set(row.ip, { until: row.until, reason: row.reason, at: row.created_at });
}

function clientIp(request) {
  if (trustProxy) {
    const parts = String(request.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];       // the address our trusted proxy saw
  }
  return request.socket.remoteAddress || 'unknown';
}
const isLoopback = ip => ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.');
const mask = email => String(email).replace(/^(.).*(@.*)$/, '$1***$2');

function log(type, ip, detail) {
  const event = { at: new Date().toISOString(), type, ip: ip || '', detail: String(detail || '').slice(0, 200) };
  recent.unshift(event); if (recent.length > 200) recent.length = 200;
  try {
    if (sql) {
      sql.prepare('INSERT INTO security_events (at, type, ip, detail) VALUES (?, ?, ?, ?)').run(event.at, event.type, event.ip, event.detail);
      if (Math.random() < 0.05) sql.exec('DELETE FROM security_events WHERE id <= (SELECT MAX(id) - 500 FROM security_events)');
    }
  } catch (error) { console.error('security log failed', error.message); }
}

function blockIp(ip, ms, reason) {
  const entry = { until: Date.now() + ms, reason, at: new Date().toISOString() };
  blocked.set(ip, entry);
  try { sql?.prepare('INSERT OR REPLACE INTO blocked_ips (ip, until, reason, created_at) VALUES (?, ?, ?, ?)').run(ip, entry.until, reason, entry.at); } catch {}
  log('blocked', ip, reason);
}
function unblock(ip) {
  blocked.delete(ip); strikes.delete(ip);
  try { sql?.prepare('DELETE FROM blocked_ips WHERE ip = ?').run(ip); } catch {}
  log('unblocked', ip, 'Unblocked by admin');
}

function hit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) { bucket = { count: 0, reset: now + windowMs }; buckets.set(key, bucket); }
  bucket.count += 1;
  return { ok: bucket.count <= max, retry: Math.max(1, Math.ceil((bucket.reset - now) / 1000)) };
}
function strike(ip) {
  const now = Date.now();
  let entry = strikes.get(ip);
  if (!entry || entry.reset <= now) entry = { count: 0, reset: now + 10 * MIN };
  entry.count += 1; strikes.set(ip, entry);
  if (entry.count >= 10) blockIp(ip, 15 * MIN, 'Repeated rate-limit abuse');
}

// ---- brute-force protection for sign-in ----
function failRecord(key, limit, lockMs, windowMs = 15 * MIN) {
  const now = Date.now();
  let record = failed.get(key);
  if (!record || now - record.first > windowMs) record = { count: 0, first: now, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= limit) record.lockedUntil = now + lockMs;
  failed.set(key, record);
  return record;
}
function loginLocked(email, ip) {
  const now = Date.now();
  const until = Math.max(failed.get(`u:${email}|${ip}`)?.lockedUntil || 0, failed.get(`u:${email}`)?.lockedUntil || 0);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}
function loginFailed(email, ip) {
  const a = failRecord(`u:${email}|${ip}`, 5, 15 * MIN);
  const b = failRecord(`u:${email}`, 25, 15 * MIN);
  if (a.count === 5 || b.count === 25) log('lockout', ip, `Sign-in locked for ${mask(email)} after repeated failures`);
  const c = failRecord(`ip:${ip}`, 40, 30 * MIN, 60 * MIN);
  if (c.count === 40 && !isLoopback(ip)) blockIp(ip, 30 * MIN, 'Too many failed sign-ins from this address');
}
function loginOk(email, ip) { failed.delete(`u:${email}|${ip}`); failed.delete(`u:${email}`); }

// ---- security headers ----
let cspScriptHashes = '';
function computeInlineScriptHashes(root) {
  const hashes = [];
  try {
    for (const file of fs.readdirSync(root).filter(name => name.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(root, file), 'utf8');
      for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) hashes.push(`'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
    }
  } catch {}
  cspScriptHashes = [...new Set(hashes)].join(' ');
}
function applyHeaders(request, response) {
  const csp = ["default-src 'self'", `script-src 'self' ${cspScriptHashes}`.trim(), "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"].join('; ');
  response.setHeader('Content-Security-Policy', csp);
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (isProd) response.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

// ---- the firewall. Returns true when it has already answered the request. ----
function inspect(request, response) {
  const ip = clientIp(request);
  const local = !strict && isLoopback(ip);
  const method = request.method;
  const rawUrl = request.url || '/';
  const isApi = rawUrl.startsWith('/api/');
  const reject = (status, message, extra = {}) => {
    response.writeHead(status, { 'Content-Type': isApi ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    response.end(isApi ? JSON.stringify({ error: message }) : message);
    return true;
  };

  if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) return reject(405, 'Method not allowed', { Allow: 'GET, HEAD, POST, PATCH, DELETE' });
  if (rawUrl.length > 2048) return reject(414, 'URL too long');

  const entry = !local && blocked.get(ip);
  if (entry) {
    if (entry.until > Date.now()) return reject(403, 'Your access has been temporarily blocked because of suspicious activity.', { 'Retry-After': String(Math.ceil((entry.until - Date.now()) / 1000)) });
    unblock(ip);
  }

  let decoded;
  try { decoded = decodeURIComponent(rawUrl); } catch { return reject(400, 'Bad request'); }
  if (PROBE.test(decoded)) {
    if (!local) blockIp(ip, PROBE_BLOCK, `Scanner probe: ${decoded.slice(0, 80)}`); else log('probe', ip, decoded.slice(0, 80));
    return reject(404, 'Not found');
  }

  // Honeypot: a hidden form field no human can see. Bots fill it in.
  const trap = request.headers['x-workwise-trap'];
  if (trap && String(trap).trim()) {
    if (!local) blockIp(ip, 24 * 60 * MIN, 'Honeypot field filled in (bot)'); else log('honeypot', ip, 'Hidden field was filled in');
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('{"ok":true}');                              // look successful so the bot learns nothing
    return true;
  }

  if (Number(request.headers['content-length']) > MAX_BODY) return reject(413, 'Request is too large.');

  // CSRF: browsers always send Origin on cross-site writes. It must match this site.
  if (method !== 'GET' && method !== 'HEAD' && request.headers.origin) {
    let originHost = '';
    try { originHost = new URL(request.headers.origin).host; } catch {}
    if (originHost !== request.headers.host) { log('csrf', ip, `Cross-site write blocked from ${String(request.headers.origin).slice(0, 80)}`); return reject(403, 'Cross-site request blocked.'); }
  }

  if (!local) {
    const route = rawUrl.split('?')[0];
    let rule;
    if (method === 'POST' && (route === '/api/auth/login' || route === '/api/admin/setup')) rule = ['login', 20, 10 * MIN];
    else if (method === 'POST' && route === '/api/auth/register') rule = ['register', 8, 60 * MIN];
    else if (method === 'POST' && (route === '/api/auth/forgot' || route === '/api/auth/reset')) rule = ['recover', 10, 60 * MIN];
    else if (method === 'POST' && route === '/api/billing/payments') rule = ['pay', 10, 60 * MIN];
    else if (method === 'POST' && route.endsWith('/files')) rule = ['upload', 120, 10 * MIN];
    else if (isApi && method !== 'GET') rule = ['write', 120, MIN];
    else if (isApi) rule = ['read', 300, MIN];
    else rule = ['static', 600, MIN];
    const result = hit(`${rule[0]}:${ip}`, rule[1], rule[2]);
    if (!result.ok) { strike(ip); log('rate-limit', ip, `${rule[0]} limit exceeded`); return reject(429, 'Too many requests. Please slow down and try again shortly.', { 'Retry-After': String(result.retry) }); }
  }
  return false;
}

function state() {
  const now = Date.now();
  const list = [...blocked.entries()].filter(([, v]) => v.until > now).map(([ip, v]) => ({ ip, reason: v.reason, until: new Date(v.until).toISOString(), at: v.at }));
  let events = recent.slice(0, 100);
  try { if (sql) events = sql.prepare('SELECT at, type, ip, detail FROM security_events ORDER BY id DESC LIMIT 100').all().map(row => ({ ...row })); } catch {}
  return { blocked: list, events };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.reset <= now) buckets.delete(key);
  for (const [key, entry] of strikes) if (entry.reset <= now) strikes.delete(key);
  for (const [key, record] of failed) if (now - record.first > 60 * MIN && record.lockedUntil < now) failed.delete(key);
}, MIN).unref();

module.exports = { init, inspect, applyHeaders, computeInlineScriptHashes, clientIp, log, blockIp, unblock, state, loginLocked, loginFailed, loginOk, mask };
