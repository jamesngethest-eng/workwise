'use strict';
// Chat attachments: files, photos, videos and whole folders.
// Uploads are streamed to disk (never held in memory) and only conversation members can download them.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline, Transform } = require('node:stream');

const MAX_MB = () => Number(process.env.MAX_UPLOAD_MB) || 50;
const DAILY_MB = () => Number(process.env.MAX_DAILY_UPLOAD_MB) || 500;
const MAX_FILES_PER_MESSAGE = 50;
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'jar', 'lnk', 'reg', 'hta', 'cpl', 'dll', 'apk']);
const SAFE_INLINE = {
  png: ['image/png', 'image'], jpg: ['image/jpeg', 'image'], jpeg: ['image/jpeg', 'image'], gif: ['image/gif', 'image'], webp: ['image/webp', 'image'],
  mp4: ['video/mp4', 'video'], webm: ['video/webm', 'video'], ogv: ['video/ogg', 'video'], mov: ['video/quicktime', 'video'], m4v: ['video/mp4', 'video']
};
const extOf = name => path.extname(name).slice(1).toLowerCase();
const cleanName = value => (String(value || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 150)) || 'file';
const cleanFolder = value => String(value || '').split(/[\\/]+/).map(part => part.replace(/[:*?"<>|\x00-\x1f]/g, '_').trim()).filter(part => part && part !== '.' && part !== '..').slice(0, 8).join('/').slice(0, 300);

function describe(file) {
  const meta = SAFE_INLINE[extOf(file.name)];
  return { id: file.id, name: file.name, path: file.path, size: file.size, kind: meta ? meta[1] : 'file' };
}

// Called by the message route: validates the files a user wants to attach and marks them as sent.
function claim(database, conversation, user, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  if (ids.length > MAX_FILES_PER_MESSAGE) throw Object.assign(new Error(`You can attach up to ${MAX_FILES_PER_MESSAGE} files at once.`), { status: 400 });
  const out = [];
  for (const id of new Set(ids.map(String))) {
    const file = database.messageFiles?.[id];
    if (!file || file.conversationId !== conversation.id || file.uploaderId !== user.id || file.attached) throw Object.assign(new Error('One of the attachments is no longer available. Please attach it again.'), { status: 400 });
    file.attached = true; out.push(describe(file));
  }
  return out;
}

async function handle(ctx) {
  const { method, pathname, request, response, send, user, database, saveDatabase, uploadDir, guard, ip } = ctx;
  database.messageFiles ||= {};

  if (method === 'GET' && pathname === '/api/files/config') return send(200, { maxMb: MAX_MB(), maxFiles: MAX_FILES_PER_MESSAGE, blocked: [...BLOCKED_EXT] });

  const upload = method === 'POST' && pathname.match(/^\/api\/conversations\/([^/]+)\/files$/);
  if (upload) {
    if (!user) return send(401, { error: 'Sign in to send files.' });
    const conversation = database.conversations.find(item => item.id === upload[1]);
    if (!conversation || !conversation.participantIds.includes(user.id)) return send(404, { error: 'Conversation not found.' });
    const length = Number(request.headers['content-length']);
    const max = MAX_MB() * 1024 * 1024;
    if (!Number.isFinite(length) || length <= 0) return send(411, { error: 'Missing file size.' });
    if (length > max) { response.setHeader('Connection', 'close'); return send(413, { error: `Files can be up to ${MAX_MB()} MB each.` }); }
    let name, folder;
    try { name = cleanName(decodeURIComponent(request.headers['x-file-name'] || '')); folder = cleanFolder(decodeURIComponent(request.headers['x-file-path'] || '')); }
    catch { return send(400, { error: 'Bad file name.' }); }
    if (BLOCKED_EXT.has(extOf(name))) return send(400, { error: `.${extOf(name)} files cannot be sent for safety reasons. Put it in a .zip file if you must share it.` });
    const dayAgo = Date.now() - 86_400_000;
    const usedToday = Object.values(database.messageFiles).filter(file => file.uploaderId === user.id && file.createdAt > dayAgo).reduce((sum, file) => sum + file.size, 0);
    if (usedToday + length > DAILY_MB() * 1024 * 1024) return send(429, { error: 'Daily upload limit reached. Try again tomorrow.' });
    for (const [id, file] of Object.entries(database.messageFiles)) if (!file.attached && Date.now() - file.createdAt > 3_600_000) { try { fs.unlinkSync(path.join(uploadDir, file.storedName)); } catch {} delete database.messageFiles[id]; }

    const id = crypto.randomUUID();
    const storedName = `msg-${id}`;
    const target = path.join(uploadDir, storedName);
    let size = 0, tooBig = false;
    const counter = new Transform({ transform(chunk, _enc, callback) { size += chunk.length; if (size > max) { tooBig = true; callback(new Error('too big')); } else callback(null, chunk); } });
    await new Promise(resolve => pipeline(request, counter, fs.createWriteStream(target, { flags: 'wx' }), error => {
      if (error) { try { fs.unlinkSync(target); } catch {} resolve(error); } else resolve(null);
    })).then(error => {
      if (error) { send(tooBig ? 413 : 400, { error: tooBig ? `Files can be up to ${MAX_MB()} MB each.` : 'Upload was interrupted.' }); return; }
      database.messageFiles[id] = { id, conversationId: conversation.id, uploaderId: user.id, name, path: folder, size, storedName, createdAt: Date.now(), attached: false };
      saveDatabase();
      guard.log('upload', ip, `${size} bytes`);
      send(201, describe(database.messageFiles[id]));
    });
    return;
  }

  const download = method === 'GET' && pathname.match(/^\/api\/files\/([0-9a-f-]{36})$/);
  if (download) {
    if (!user) return send(401, { error: 'Sign in to open files.' });
    const file = database.messageFiles[download[1]];
    const conversation = file && database.conversations.find(item => item.id === file.conversationId);
    if (!file || !file.attached || !conversation || !conversation.participantIds.includes(user.id)) return send(404, { error: 'File not found.' });
    const full = path.join(uploadDir, file.storedName);
    let stat; try { stat = fs.statSync(full); } catch { return send(404, { error: 'File is no longer available.' }); }
    const meta = SAFE_INLINE[extOf(file.name)];
    const inline = Boolean(meta) && !new URL(request.url, 'http://x').searchParams.has('download');
    const headers = {
      'Content-Type': meta ? meta[0] : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, max-age=600', 'Accept-Ranges': 'bytes'
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      start = Math.max(0, start); end = Math.min(end, stat.size - 1);
      if (start > end || start >= stat.size) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return response.end(); }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      return void fs.createReadStream(full, { start, end }).pipe(response);
    }
    response.writeHead(200, { ...headers, 'Content-Length': stat.size });
    return void fs.createReadStream(full).pipe(response);
  }
  return false;
}
module.exports = { handle, claim };
