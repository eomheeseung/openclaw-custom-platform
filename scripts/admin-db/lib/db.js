const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_PATH = '/opt/openclaw/data/_admin.sqlite';
const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '001_initial.sql');

function openDb(dbPath = DEFAULT_DB_PATH) {
  const fresh = !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  if (fresh) {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    db.exec(sql);
  }
  return db;
}

function now() { return Date.now(); }

module.exports = { openDb, DEFAULT_DB_PATH, now };
