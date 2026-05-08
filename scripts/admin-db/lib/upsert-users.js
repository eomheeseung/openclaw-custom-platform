const fs = require('fs');
const { now } = require('./db');

const USERS_JSON = '/opt/openclaw/auth/users.json';

function upsertUsers(db) {
  if (!fs.existsSync(USERS_JSON)) return 0;
  const map = JSON.parse(fs.readFileSync(USERS_JSON, 'utf8'));
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO users (slot, email, name, status, created_at, updated_at)
    VALUES (@slot, @email, @name, 'active', @ts, @ts)
    ON CONFLICT(slot) DO UPDATE SET
      email = excluded.email,
      status = 'active',
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r); });
  const rows = Object.entries(map).map(([email, slot]) => ({
    slot: String(slot).padStart(2, '0'),
    email,
    name: null,
    ts,
  }));
  tx(rows);
  // soft-delete: 매핑에서 빠진 슬롯은 inactive
  const known = new Set(rows.map(r => r.slot));
  const all = db.prepare('SELECT slot FROM users').all();
  const inact = db.prepare('UPDATE users SET status=?, updated_at=? WHERE slot=?');
  for (const r of all) {
    if (!known.has(r.slot)) inact.run('inactive', ts, r.slot);
  }
  return rows.length;
}

module.exports = { upsertUsers };
