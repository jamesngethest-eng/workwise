const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 8000;
const root = path.resolve(__dirname);
const dataDir = path.resolve(process.env.WORKWISE_DATA_DIR || path.join(root, '.workwise-data'));
const uploadDir = path.join(dataDir, 'uploads');
const dbPath = path.join(dataDir, 'database.json');
fs.mkdirSync(uploadDir, { recursive: true });
const sessions = new Map();
let database = loadDatabase();
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

function loadDatabase() {
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch {
    const initial = { users: [], jobs: [], applications: [] };
    fs.writeFileSync(dbPath, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function saveDatabase() {
  const tempPath = `${dbPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(database, null, 2));
  fs.renameSync(tempPath, dbPath);
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}

function readJson(request, maxBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

function isLocalRequest(request) {
  const address = request.socket.remoteAddress || '';
  return address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');
}

function sessionUser(request) {
  const cookie = request.headers.cookie || '';
  const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('workwise_session='))?.slice('workwise_session='.length);
  const userId = token && sessions.get(token);
  return database.users.find(user => user.id === userId) || null;
}

function establishSession(user, response) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, user.id);
  response.setHeader('Set-Cookie', `workwise_session=${token}; ${cookieOptions()}`);
}

function passwordRecord(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve({ salt, hash: key.toString('hex') })));
}

async function passwordMatches(password, record) {
  const derived = await passwordRecord(password, record.salt);
  return crypto.timingSafeEqual(Buffer.from(derived.hash, 'hex'), Buffer.from(record.hash, 'hex'));
}

async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;
  const user = sessionUser(request);
  const requireRole = role => {
    if (!user) { sendJson(response, 401, { error: 'Sign in to continue.' }); return false; }
    if (user.role !== role && user.role !== 'admin') { sendJson(response, 403, { error: 'You do not have permission to do that.' }); return false; }
    return true;
  };

  if (method === 'GET' && pathname === '/api/health') return sendJson(response, 200, { ok: true });

  if (method === 'POST' && pathname === '/api/auth/register') {
    const body = await readJson(request, 40_000);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = body.role === 'employer' ? 'employer' : 'freelancer';
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return sendJson(response, 400, { error: 'Enter a valid email and a password with at least 8 characters.' });
    if (database.users.some(item => item.email === email)) return sendJson(response, 409, { error: 'An account with that email already exists. Sign in instead.' });
    const credentials = await passwordRecord(password);
    const created = { id: crypto.randomUUID(), email, name: String(body.name || email.split('@')[0]), role, ...credentials, createdAt: new Date().toISOString() };
    database.users.push(created); saveDatabase(); establishSession(created, response);
    return sendJson(response, 201, { id: created.id, email: created.email, name: created.name, role: created.role });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(request, 40_000);
    const email = String(body.email || '').trim().toLowerCase();
    const found = database.users.find(item => item.email === email);
    if (!found || !(await passwordMatches(String(body.password || ''), found))) return sendJson(response, 401, { error: 'Email or password is incorrect.' });
    if (body.role && found.role !== body.role) return sendJson(response, 403, { error: `This account is registered as ${found.role}.` });
    establishSession(found, response);
    return sendJson(response, 200, { id: found.id, email: found.email, name: found.name, role: found.role });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const cookie = request.headers.cookie || '';
    const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('workwise_session='))?.slice('workwise_session='.length);
    if (token) sessions.delete(token);
    response.setHeader('Set-Cookie', `workwise_session=; ${cookieOptions()}; Max-Age=0`);
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    if (!user) return sendJson(response, 401, { error: 'Not signed in.' });
    return sendJson(response, 200, { id: user.id, email: user.email, name: user.name, role: user.role });
  }

  if (method === 'GET' && pathname === '/api/admin/setup-needed') {
    return sendJson(response, 200, { needed: !database.users.some(item => item.role === 'admin'), setupKeyRequired: Boolean(process.env.WORKWISE_ADMIN_SETUP_KEY) });
  }

  if (method === 'POST' && pathname === '/api/admin/setup') {
    if (database.users.some(item => item.role === 'admin')) return sendJson(response, 409, { error: 'An admin account is already set up.' });
    const body = await readJson(request, 40_000);
    const setupKey = process.env.WORKWISE_ADMIN_SETUP_KEY;
    if (setupKey && body.setupKey !== setupKey) return sendJson(response, 403, { error: 'The admin setup key is incorrect.' });
    if (!setupKey && !isLocalRequest(request)) return sendJson(response, 503, { error: 'Set WORKWISE_ADMIN_SETUP_KEY before creating the first admin account.' });
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10) return sendJson(response, 400, { error: 'Enter a valid email and a password with at least 10 characters.' });
    if (database.users.some(item => item.email === email)) return sendJson(response, 409, { error: 'That email is already in use.' });
    const credentials = await passwordRecord(password);
    const admin = { id: crypto.randomUUID(), email, name: 'Administrator', role: 'admin', ...credentials, createdAt: new Date().toISOString() };
    database.users.push(admin); saveDatabase(); establishSession(admin, response);
    return sendJson(response, 201, { id: admin.id, email: admin.email, name: admin.name, role: admin.role });
  }

  if (method === 'GET' && pathname === '/api/jobs') {
    return sendJson(response, 200, database.jobs.filter(job => job.status === 'published'), { 'X-Workwise-Seeds-Initialized': String(Boolean(database.seedJobsInitialized)) });
  }

  if (method === 'POST' && pathname === '/api/jobs') {
    if (!requireRole('employer')) return;
    const body = await readJson(request, 80_000);
    if (!String(body.title || '').trim() || !String(body.description || '').trim()) return sendJson(response, 400, { error: 'Job title and description are required.' });
    const job = { id: crypto.randomUUID(), ownerId: user.id, client: String(body.client || user.name), title: String(body.title).trim(), category: String(body.category || 'Design & Creative'), level: String(body.level || 'Intermediate'), description: String(body.description).trim(), type: body.type === 'Hourly' || body.type === 'hourly' ? 'Hourly' : 'Fixed price', budget: String(body.budget || '').trim(), tags: Array.isArray(body.tags) ? body.tags : [String(body.category || 'Design & Creative')], status: 'published', createdAt: new Date().toISOString() };
    database.jobs.push(job); saveDatabase();
    return sendJson(response, 201, job);
  }

  if (method === 'GET' && pathname === '/api/employer/jobs') {
    if (!requireRole('employer')) return;
    return sendJson(response, 200, database.jobs.filter(job => job.ownerId === user.id));
  }

  if (method === 'GET' && pathname === '/api/employer/applications') {
    if (!requireRole('employer')) return;
    const owned = new Set(database.jobs.filter(job => job.ownerId === user.id).map(job => job.id));
    return sendJson(response, 200, database.applications.filter(application => owned.has(application.jobId)).map(({ attachments, ...application }) => ({ ...application, attachments: Object.fromEntries(Object.entries(attachments || {}).map(([kind, value]) => [kind, value.originalName])) })));
  }

  if (method === 'GET' && pathname === '/api/admin/applications') {
    if (!requireRole('admin')) return;
    return sendJson(response, 200, database.applications.map(({ attachments, ...application }) => ({ ...application, attachments: Object.fromEntries(Object.entries(attachments || {}).map(([kind, value]) => [kind, value.originalName])) })));
  }

  if (method === 'GET' && pathname === '/api/admin/jobs') {
    if (!requireRole('admin')) return;
    return sendJson(response, 200, database.jobs);
  }

  if (method === 'POST' && pathname === '/api/admin/seed-jobs') {
    if (!requireRole('admin')) return;
    if (database.seedJobsInitialized) return sendJson(response, 200, { initialized: true });
    const body = await readJson(request, 250_000);
    if (!Array.isArray(body.jobs)) return sendJson(response, 400, { error: 'Seed jobs must be provided as a list.' });
    for (const source of body.jobs) {
      const id = Number(source.id);
      if (!Number.isInteger(id) || id < 1 || database.jobs.some(job => String(job.id) === String(id))) continue;
      database.jobs.push({ id, kind: 'seed', ownerId: null, client: String(source.client || 'Workwise client'), title: String(source.title || ''), category: String(source.category || 'Design & Creative'), level: String(source.level || 'Intermediate'), description: String(source.description || ''), type: source.type === 'hourly' ? 'Hourly' : 'Fixed price', budget: String(source.type === 'hourly' ? source.budgetText || source.budget || '' : source.budgetText || source.budget || ''), tags: Array.isArray(source.tags) ? source.tags : String(source.tags || '').split(',').map(tag => tag.trim()).filter(Boolean), status: 'published', duration: String(source.duration || 'Project duration TBD'), rating: String(source.rating || 'New client'), verified: Boolean(source.verified), proposals: String(source.proposals || '0'), createdAt: new Date().toISOString() });
    }
    database.seedJobsInitialized = true; saveDatabase();
    return sendJson(response, 201, { initialized: true });
  }

  if (pathname.startsWith('/api/admin/jobs/')) {
    if (!requireRole('admin')) return;
    const id = pathname.slice('/api/admin/jobs/'.length);
    const index = database.jobs.findIndex(job => String(job.id) === id);
    if (index < 0) return sendJson(response, 404, { error: 'Job not found.' });
    if (method === 'DELETE') { if (database.jobs[index].kind === 'seed') database.jobs[index].status = 'removed'; else database.jobs.splice(index, 1); saveDatabase(); return sendJson(response, 200, { ok: true }); }
    if (method === 'PATCH') { const body = await readJson(request, 80_000); database.jobs[index] = { ...database.jobs[index], ...body, id }; saveDatabase(); return sendJson(response, 200, database.jobs[index]); }
  }

  if (method === 'POST' && pathname === '/api/applications') {
    if (!requireRole('freelancer')) return;
    const body = await readJson(request, 20 * 1024 * 1024);
    let job = database.jobs.find(item => item.id === String(body.jobId));
    if (!job && body.jobTitle) job = { id: String(body.jobId), title: String(body.jobTitle), client: String(body.client || 'Workwise marketplace'), ownerId: null };
    if (!job) return sendJson(response, 404, { error: 'This job is no longer available for applications.' });
    if (job.ownerId && job.ownerId === user.id) return sendJson(response, 400, { error: 'You cannot apply to your own job.' });
    if (!String(body.coverLetter || '').trim() || String(body.coverLetter).trim().length < 50) return sendJson(response, 400, { error: 'Please write a cover letter of at least 50 characters.' });
    const attachments = {};
    for (const kind of ['resume', 'coverPhoto']) {
      const attachment = body.attachments?.[kind];
      if (!attachment?.data || !attachment.name) continue;
      const bytes = Buffer.from(attachment.data, 'base64');
      if (bytes.length > (kind === 'resume' ? 8 : 5) * 1024 * 1024) return sendJson(response, 413, { error: `${kind === 'resume' ? 'Resume' : 'Cover photo'} file is too large.` });
      const filename = `${crypto.randomUUID()}${path.extname(String(attachment.name)).slice(0, 10)}`;
      fs.writeFileSync(path.join(uploadDir, filename), bytes, { flag: 'wx' });
      attachments[kind] = { filename, originalName: path.basename(attachment.name), contentType: String(attachment.type || 'application/octet-stream') };
    }
    if (!attachments.resume) return sendJson(response, 400, { error: 'Attach a CV or resume before applying.' });
    const application = { id: crypto.randomUUID(), jobId: job.id, jobTitle: job.title, applicantId: user.id, applicantName: user.name, email: user.email, rate: String(body.rate || ''), availability: String(body.availability || ''), coverLetter: String(body.coverLetter || '').slice(0, 3000), attachments, submittedAt: new Date().toISOString() };
    database.applications.push(application); saveDatabase();
    return sendJson(response, 201, { id: application.id, jobTitle: application.jobTitle, submittedAt: application.submittedAt });
  }

  if (method === 'GET' && pathname.startsWith('/api/applications/') && pathname.includes('/attachments/')) {
    if (!user) return sendJson(response, 401, { error: 'Sign in to continue.' });
    const [, , , applicationId, , kind] = pathname.split('/');
    const application = database.applications.find(item => item.id === applicationId);
    const job = application && database.jobs.find(item => String(item.id) === String(application.jobId));
    if (!application || (user.role !== 'admin' && (!job || job.ownerId !== user.id))) return sendJson(response, 404, { error: 'Attachment not found.' });
    const attachment = application.attachments?.[kind];
    if (!attachment) return sendJson(response, 404, { error: 'Attachment not found.' });
    const file = path.join(uploadDir, attachment.filename);
    if (!fs.existsSync(file)) return sendJson(response, 404, { error: 'Attachment file is missing.' });
    response.writeHead(200, { 'Content-Type': attachment.contentType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`, 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(file).pipe(response);
  }

  if (pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'API route not found.' });
  return false;
}

const server = http.createServer(async (request, response) => {
  let url;
  try { url = new URL(request.url, `http://${host}:${port}`); }
  catch { response.writeHead(400); response.end('Bad request'); return; }
  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await handleApi(request, response, url);
      if (handled !== false) return;
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : 'Server error.' });
      else response.destroy();
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${host}:${port}`).pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  if (pathname.split('/').some(part => part.startsWith('.'))) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const filePath = path.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(root + path.sep)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Set PORT to use another port.`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

console.log('Starting Workwise server');
server.listen(port, host, () => console.log(`Workwise server ready at http://${host}:${port}`));
