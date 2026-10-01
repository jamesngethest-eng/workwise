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
let database = loadDatabase();
database.sessions ||= [];
database.conversations ||= [];
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

function cookieOptions(maxAgeSeconds) {
  return `Path=/; HttpOnly; SameSite=Lax${maxAgeSeconds ? `; Max-Age=${maxAgeSeconds}` : ''}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

function isLocalRequest(request) {
  const address = request.socket.remoteAddress || '';
  return address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');
}

function sessionUser(request) {
  const cookie = request.headers.cookie || '';
  const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('workwise_session='))?.slice('workwise_session='.length);
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = database.sessions.find(item => item.tokenHash === tokenHash);
  if (!session || (session.expiresAt && session.expiresAt <= Date.now())) return null;
  return database.users.find(user => user.id === session.userId) || null;
}

function establishSession(user, response, rememberMe = false) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionLifetime = rememberMe ? 30 * 24 * 60 * 60 : 8 * 60 * 60;
  const cookieMaxAge = rememberMe ? sessionLifetime : null;
  database.sessions = database.sessions.filter(item => !item.expiresAt || item.expiresAt > Date.now());
  database.sessions.push({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, expiresAt: Date.now() + sessionLifetime * 1000 });
  saveDatabase();
  response.setHeader('Set-Cookie', `workwise_session=${token}; ${cookieOptions(cookieMaxAge)}`);
}

function passwordRecord(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve({ salt, hash: key.toString('hex') })));
}

async function passwordMatches(password, record) {
  const derived = await passwordRecord(password, record.salt);
  return crypto.timingSafeEqual(Buffer.from(derived.hash, 'hex'), Buffer.from(record.hash, 'hex'));
}

function getOrCreateConversation(participantIds, details = {}) {
  const uniqueParticipantIds = [...new Set(participantIds)];
  const existing = database.conversations.find(conversation => {
    if (details.applicationId) return conversation.applicationId === details.applicationId;
    return conversation.kind === details.kind && String(conversation.jobId || '') === String(details.jobId || '') && uniqueParticipantIds.every(id => conversation.participantIds.includes(id)) && conversation.participantIds.length === uniqueParticipantIds.length;
  });
  if (existing) return existing;
  const conversation = {
    id: crypto.randomUUID(), participantIds: uniqueParticipantIds,
    kind: details.kind || 'application', jobId: details.jobId || null,
    applicationId: details.applicationId || null, status: details.status || 'open',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: []
  };
  database.conversations.push(conversation);
  return conversation;
}

function profileSummary(userId) {
  const profile = database.users.find(item => item.id === userId)?.profile || {};
  return { title: profile.title || '', location: profile.location || '', skills: Array.isArray(profile.skills) ? profile.skills : [], portfolioUrl: profile.portfolioUrl || '' };
}

function describeConversation(conversation, viewerId) {
  const peer = database.users.find(user => conversation.participantIds.find(id => id !== viewerId) === user.id);
  const job = database.jobs.find(item => String(item.id) === String(conversation.jobId));
  const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
  return {
    id: conversation.id, kind: conversation.kind, status: conversation.status,
    jobId: conversation.jobId, jobTitle: job?.title || 'Direct message',
    peer: peer ? { id: peer.id, name: peer.name, role: peer.role } : { id: '', name: 'Workwise member', role: 'member' },
    messages: conversation.messages, lastMessage
  };
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
    database.users.push(created); saveDatabase(); establishSession(created, response, Boolean(body.rememberMe));
    return sendJson(response, 201, { id: created.id, email: created.email, name: created.name, role: created.role });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(request, 40_000);
    const email = String(body.email || '').trim().toLowerCase();
    const found = database.users.find(item => item.email === email);
    if (!found || !(await passwordMatches(String(body.password || ''), found))) return sendJson(response, 401, { error: 'Email or password is incorrect.' });
    if (body.role && found.role !== body.role) return sendJson(response, 403, { error: `This account is registered as ${found.role}.` });
    establishSession(found, response, Boolean(body.rememberMe));
    return sendJson(response, 200, { id: found.id, email: found.email, name: found.name, role: found.role });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const cookie = request.headers.cookie || '';
    const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('workwise_session='))?.slice('workwise_session='.length);
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      database.sessions = database.sessions.filter(item => item.tokenHash !== tokenHash);
      saveDatabase();
    }
    response.setHeader('Set-Cookie', `workwise_session=; ${cookieOptions()}; Max-Age=0`);
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    if (!user) return sendJson(response, 401, { error: 'Not signed in.' });
    return sendJson(response, 200, { id: user.id, email: user.email, name: user.name, role: user.role });
  }

  if (pathname === '/api/profile' && method === 'GET') {
    if (!user) return sendJson(response, 401, { error: 'Sign in to edit your profile.' });
    return sendJson(response, 200, {
      name: user.name,
      profile: {
        title: user.profile?.title || '',
        location: user.profile?.location || '',
        bio: user.profile?.bio || '',
        skills: Array.isArray(user.profile?.skills) ? user.profile.skills : [],
        portfolioUrl: user.profile?.portfolioUrl || ''
      }
    });
  }

  if (pathname === '/api/profile' && method === 'PATCH') {
    if (!user) return sendJson(response, 401, { error: 'Sign in to edit your profile.' });
    const body = await readJson(request, 20_000);
    const name = String(body.name || '').trim();
    const profile = body.profile && typeof body.profile === 'object' ? body.profile : {};
    if (name.length < 2 || name.length > 60) return sendJson(response, 400, { error: 'Enter a name between 2 and 60 characters.' });
    const title = String(profile.title || '').trim();
    const location = String(profile.location || '').trim();
    const bio = String(profile.bio || '').trim();
    const portfolioUrl = String(profile.portfolioUrl || '').trim();
    const skills = Array.isArray(profile.skills) ? [...new Set(profile.skills.map(skill => String(skill).trim()).filter(Boolean))].slice(0, 12) : [];
    if (title.length > 80 || location.length > 80 || bio.length > 600 || skills.some(skill => skill.length > 40)) {
      return sendJson(response, 400, { error: 'One or more profile fields are too long.' });
    }
    if (portfolioUrl) {
      try {
        const parsedUrl = new URL(portfolioUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
      } catch {
        return sendJson(response, 400, { error: 'Enter a valid portfolio URL starting with https:// or http://.' });
      }
    }
    user.name = name;
    user.profile = { title, location, bio, skills, portfolioUrl };
    saveDatabase();
    return sendJson(response, 200, { name: user.name, role: user.role, profile: user.profile });
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
    database.users.push(admin); saveDatabase(); establishSession(admin, response, Boolean(body.rememberMe));
    return sendJson(response, 201, { id: admin.id, email: admin.email, name: admin.name, role: admin.role });
  }

  if (method === 'GET' && pathname === '/api/jobs') {
    return sendJson(response, 200, database.jobs.filter(job => job.status === 'published'), { 'X-Workwise-Seeds-Initialized': String(Boolean(database.seedJobsInitialized)) });
  }

  if (method === 'POST' && pathname === '/api/jobs') {
    if (!requireRole('employer')) return;
    const body = await readJson(request, 80_000);
    if (!String(body.title || '').trim() || !String(body.description || '').trim()) return sendJson(response, 400, { error: 'Job title and description are required.' });
    const duplicate = database.jobs.find(item => item.ownerId === user.id && item.title === String(body.title).trim() && item.description === String(body.description).trim() && Date.now() - Date.parse(item.createdAt) < 60_000);
    if (duplicate) return sendJson(response, 200, duplicate);
    const job = { id: crypto.randomUUID(), ownerId: user.id, client: String(body.client || user.name), title: String(body.title).trim(), category: String(body.category || 'Design & Creative'), level: String(body.level || 'Intermediate'), description: String(body.description).trim(), type: body.type === 'Hourly' || body.type === 'hourly' ? 'Hourly' : 'Fixed price', budget: String(body.budget || '').trim(), tags: Array.isArray(body.tags) ? body.tags : [String(body.category || 'Design & Creative')], status: 'published', createdAt: new Date().toISOString() };
    database.jobs.push(job); saveDatabase();
    return sendJson(response, 201, job);
  }

  if (method === 'GET' && pathname === '/api/employer/jobs') {
    if (!requireRole('employer')) return;
    return sendJson(response, 200, database.jobs.filter(job => job.ownerId === user.id));
  }

  if (method === 'DELETE' && pathname.startsWith('/api/employer/jobs/')) {
    if (!requireRole('employer')) return;
    const id = decodeURIComponent(pathname.slice('/api/employer/jobs/'.length));
    const index = database.jobs.findIndex(job => String(job.id) === id && job.ownerId === user.id);
    if (index < 0) return sendJson(response, 404, { error: 'Job not found in your posts.' });
    database.jobs.splice(index, 1);
    saveDatabase();
    return sendJson(response, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/employer/applications') {
    if (!requireRole('employer')) return;
    const owned = new Set(database.jobs.filter(job => job.ownerId === user.id).map(job => job.id));
    return sendJson(response, 200, database.applications.filter(application => owned.has(application.jobId)).map(({ attachments, ...application }) => ({ ...application, conversationId: database.conversations.find(item => item.applicationId === application.id)?.id || null, applicantProfile: profileSummary(application.applicantId), status: application.status || 'pending', attachments: Object.fromEntries(Object.entries(attachments || {}).map(([kind, value]) => [kind, value.originalName])) })));
  }

  if (method === 'POST' && pathname.startsWith('/api/employer/applications/') && pathname.endsWith('/conversation')) {
    if (!requireRole('employer')) return;
    if (user.role !== 'employer') return sendJson(response, 403, { error: 'Only the employer who posted the job can message applicants.' });
    const applicationId = pathname.slice('/api/employer/applications/'.length, -'/conversation'.length);
    const application = database.applications.find(item => item.id === applicationId);
    const job = application && database.jobs.find(item => String(item.id) === String(application.jobId));
    if (!application || !job || job.ownerId !== user.id) return sendJson(response, 404, { error: 'Proposal not found for your jobs.' });
    const conversation = getOrCreateConversation([user.id, application.applicantId], { kind: 'application', jobId: job.id, applicationId: application.id, status: application.status === 'accepted' ? 'accepted' : 'open' });
    saveDatabase();
    return sendJson(response, 200, { conversationId: conversation.id, conversation: describeConversation(conversation, user.id) });
  }

  if (method === 'POST' && pathname.startsWith('/api/employer/applications/') && pathname.endsWith('/accept')) {
    if (!requireRole('employer')) return;
    if (user.role !== 'employer') return sendJson(response, 403, { error: 'Only the employer who posted the job can accept a proposal.' });
    const applicationId = pathname.slice('/api/employer/applications/'.length, -'/accept'.length);
    const application = database.applications.find(item => item.id === applicationId);
    const job = application && database.jobs.find(item => String(item.id) === String(application.jobId));
    if (!application || !job || job.ownerId !== user.id) return sendJson(response, 404, { error: 'Proposal not found for your jobs.' });
    application.status = 'accepted';
    application.acceptedAt ||= new Date().toISOString();
    const conversation = getOrCreateConversation([user.id, application.applicantId], { kind: 'application', jobId: job.id, applicationId: application.id, status: 'accepted' });
    conversation.status = 'accepted';
    saveDatabase();
    return sendJson(response, 200, { status: application.status, conversationId: conversation.id, conversation: describeConversation(conversation, user.id) });
  }

  if (method === 'GET' && pathname === '/api/admin/clients') {
    if (!requireRole('admin')) return;
    const clients = database.users.filter(item => item.role === 'employer').map(item => ({
      id: item.id, name: item.name, email: item.email, joinedAt: item.createdAt,
      jobCount: database.jobs.filter(job => job.ownerId === item.id && job.status !== 'removed').length
    })).sort((a, b) => String(b.joinedAt || '').localeCompare(String(a.joinedAt || '')));
    return sendJson(response, 200, clients);
  }

  if (method === 'POST' && pathname === '/api/admin/conversations') {
    if (!requireRole('admin')) return;
    const body = await readJson(request, 10_000);
    const recipient = database.users.find(item => item.id === body.recipientId && item.role === 'employer');
    if (!recipient) return sendJson(response, 404, { error: 'The hirer could not be found.' });
    let job = null;
    if (body.jobId) {
      job = database.jobs.find(item => String(item.id) === String(body.jobId) && item.ownerId === recipient.id);
      if (!job) return sendJson(response, 404, { error: 'That project does not belong to this hirer.' });
    }
    const conversation = getOrCreateConversation([user.id, recipient.id], { kind: 'admin-hirer', jobId: job ? job.id : null, status: 'open' });
    saveDatabase();
    return sendJson(response, 201, describeConversation(conversation, user.id));
  }

  if (method === 'GET' && pathname === '/api/conversations') {
    if (!user) return sendJson(response, 401, { error: 'Sign in to view your messages.' });
    const conversations = database.conversations.filter(item => item.participantIds.includes(user.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sendJson(response, 200, conversations.map(item => describeConversation(item, user.id)));
  }

  if (pathname.startsWith('/api/conversations/')) {
    if (!user) return sendJson(response, 401, { error: 'Sign in to view your messages.' });
    const parts = pathname.split('/').filter(Boolean);
    const conversationId = parts[2];
    const conversation = database.conversations.find(item => item.id === conversationId);
    if (!conversation || !conversation.participantIds.includes(user.id)) return sendJson(response, 404, { error: 'Conversation not found.' });
    if (method === 'GET' && parts.length === 3) return sendJson(response, 200, describeConversation(conversation, user.id));
    if (method === 'POST' && parts[3] === 'messages') {
      const body = await readJson(request, 10_000);
      const message = String(body.message || '').trim();
      if (!message || message.length > 4000) return sendJson(response, 400, { error: 'Enter a message of 1 to 4,000 characters.' });
      const saved = { id: crypto.randomUUID(), senderId: user.id, senderName: user.name, text: message, sentAt: new Date().toISOString() };
      conversation.messages.push(saved);
      conversation.updatedAt = saved.sentAt;
      saveDatabase();
      return sendJson(response, 201, saved);
    }
  }

  if (method === 'GET' && pathname === '/api/admin/applications') {
    if (!requireRole('admin')) return;
    return sendJson(response, 200, database.applications.map(({ attachments, ...application }) => ({ ...application, attachments: Object.fromEntries(Object.entries(attachments || {}).map(([kind, value]) => [kind, value.originalName])) })));
  }

  if (method === 'GET' && pathname === '/api/admin/jobs') {
    if (!requireRole('admin')) return;
    return sendJson(response, 200, database.jobs
      .filter(job => job.status !== 'removed')
      .map(job => ({ ...job, ownerRole: database.users.find(item => item.id === job.ownerId)?.role || null })));
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
    if (method === 'DELETE') {
      if (database.jobs[index].kind === 'seed') {
        database.jobs[index].status = 'removed';
      } else {
        database.jobs.splice(index, 1);
      }
      saveDatabase();
      return sendJson(response, 200, { ok: true, removed: true });
    }
    if (method === 'PATCH') {
      const body = await readJson(request, 80_000);
      database.jobs[index] = { ...database.jobs[index], ...body, id };
      if (body.status === 'published' || !body.status) {
        database.jobs[index].status = 'published';
      }
      saveDatabase();
      return sendJson(response, 200, database.jobs[index]);
    }
  }

  if (method === 'POST' && pathname === '/api/applications') {
    if (!requireRole('freelancer')) return;
    const body = await readJson(request, 20 * 1024 * 1024);
    let job = database.jobs.find(item => String(item.id) === String(body.jobId));
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
    const application = { id: crypto.randomUUID(), jobId: job.id, jobTitle: job.title, applicantId: user.id, applicantName: user.name, email: user.email, rate: String(body.rate || ''), availability: String(body.availability || ''), coverLetter: String(body.coverLetter || '').slice(0, 3000), attachments, status: 'pending', submittedAt: new Date().toISOString() };
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
