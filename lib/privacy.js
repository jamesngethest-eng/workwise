'use strict';
// Privacy controls: choose what hirers see, download your data, delete your account.
const fs = require('node:fs');
const path = require('node:path');

const showEmail = (database, userId) => Boolean(database.users.find(item => item.id === userId)?.privacy?.showEmail);

function removeQuietly(file) { try { fs.unlinkSync(file); } catch {} }

async function handle(ctx) {
  const { method, pathname, request, response, send, user, database, saveDatabase, readJson, uploadDir, passwordMatches, guard, ip } = ctx;
  if (!pathname.startsWith('/api/privacy') && !pathname.startsWith('/api/account')) return false;
  if (!user) return send(401, { error: 'Sign in to manage your privacy.' });

  if (pathname === '/api/privacy' && method === 'GET') return send(200, { showEmail: Boolean(user.privacy?.showEmail) });
  if (pathname === '/api/privacy' && method === 'PATCH') {
    const body = await readJson(request, 2_000);
    user.privacy = { ...(user.privacy || {}), showEmail: Boolean(body.showEmail) };
    saveDatabase();
    return send(200, user.privacy);
  }

  if (pathname === '/api/account/export' && method === 'GET') {
    const mine = { account: { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt, profile: user.profile || {}, privacy: user.privacy || {}, subscription: user.subscription || null },
      jobs: database.jobs.filter(job => job.ownerId === user.id),
      applications: database.applications.filter(item => item.applicantId === user.id).map(({ attachments, ...rest }) => ({ ...rest, attachments: Object.fromEntries(Object.entries(attachments || {}).map(([k, v]) => [k, v.originalName])) })),
      conversations: database.conversations.filter(item => item.participantIds.includes(user.id)).map(item => ({ id: item.id, with: database.users.find(u => item.participantIds.find(id => id !== user.id) === u.id)?.name || 'Workwise member', messages: item.messages.map(m => ({ from: m.senderName, at: m.sentAt, text: m.text, attachments: (m.attachments || []).map(a => a.name) })) })),
      payments: database.payments.filter(item => item.userId === user.id) };
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="workwise-my-data.json"', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify(mine, null, 2)), true;
  }

  if (pathname === '/api/account' && method === 'DELETE') {
    const body = await readJson(request, 2_000);
    if (user.role === 'admin') return send(400, { error: 'The administrator account cannot be deleted here.' });
    if (!(await passwordMatches(String(body.password || ''), user))) return send(403, { error: 'Your password is incorrect.' });
    for (const application of database.applications.filter(item => item.applicantId === user.id))
      for (const attachment of Object.values(application.attachments || {})) removeQuietly(path.join(uploadDir, attachment.filename));
    database.applications = database.applications.filter(item => item.applicantId !== user.id);
    const ownJobIds = new Set(database.jobs.filter(job => job.ownerId === user.id).map(job => String(job.id)));
    for (const application of database.applications.filter(item => ownJobIds.has(String(item.jobId))))
      for (const attachment of Object.values(application.attachments || {})) removeQuietly(path.join(uploadDir, attachment.filename));
    database.applications = database.applications.filter(item => !ownJobIds.has(String(item.jobId)));
    database.jobs = database.jobs.filter(job => job.ownerId !== user.id);
    const gone = new Set(database.conversations.filter(item => item.participantIds.includes(user.id)).map(item => item.id));
    for (const [id, file] of Object.entries(database.messageFiles || {})) if (gone.has(file.conversationId) || file.uploaderId === user.id) { removeQuietly(path.join(uploadDir, file.storedName)); delete database.messageFiles[id]; }
    database.conversations = database.conversations.filter(item => !gone.has(item.id));
    database.payments = database.payments.filter(item => item.userId !== user.id);
    database.sessions = database.sessions.filter(item => item.userId !== user.id);
    database.users = database.users.filter(item => item.id !== user.id);
    saveDatabase();
    guard.log('account-deleted', ip, `Account deleted: ${guard.mask(user.email)}`);
    response.setHeader('Set-Cookie', 'workwise_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return send(200, { ok: true });
  }
  return false;
}
module.exports = { handle, showEmail };
