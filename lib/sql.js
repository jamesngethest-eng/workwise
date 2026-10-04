'use strict';
// Real SQL (SQLite, built into Node 22.5+). Holds security-sensitive data:
// recovery codes, blocked IPs and the security log.
const path = require('node:path');
function open(dataDir) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'workwise.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS recovery_codes (
      email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, salt TEXT NOT NULL,
      expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS blocked_ips (
      ip TEXT PRIMARY KEY, until INTEGER NOT NULL, reason TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, ip TEXT, detail TEXT);
  `);
  return db;
}
module.exports = { open };
