const fs = require('fs');
const path = require('path');
const { now } = require('./db');

const DATA_ROOT = '/opt/openclaw/data';

const TYPE_BY_PREFIX = (id) => {
  if (id.endsWith('-discord')) return id.replace('-discord', '');
  return id;
};

function upsertAgentsForSlot(db, slot) {
  const cfgPath = path.join(DATA_ROOT, `user${slot}`, 'openclaw.json');
  if (!fs.existsSync(cfgPath)) return 0;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return 0; }
  const rawList = (cfg.agents && cfg.agents.list) || [];
  // agents.list는 object 배열: { id, name, default, ... }
  const list = rawList.map(a => (typeof a === 'string' ? { id: a } : a)).filter(a => a && a.id);
  const defaultModel = cfg.agents?.defaults?.model?.primary || null;
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO agents (user_slot, agent_id, agent_type, name, model, is_default, status, created_at, updated_at)
    VALUES (@slot, @agent_id, @agent_type, @name, @model, @is_default, 'active', @ts, @ts)
    ON CONFLICT(user_slot, agent_id) DO UPDATE SET
      agent_type = excluded.agent_type,
      name = excluded.name,
      model = excluded.model,
      is_default = excluded.is_default,
      status = 'active',
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r); });
  const rows = list.map((a) => ({
    slot,
    agent_id: a.id,
    agent_type: TYPE_BY_PREFIX(a.id),
    name: a.name || a.identity?.name || a.id,
    model: a.model || defaultModel,
    is_default: a.default ? 1 : 0,
    ts,
  }));
  tx(rows);
  // soft-archive: 파일에 없는 agents는 archived
  const known = new Set(list.map(a => a.id));
  const exist = db.prepare('SELECT agent_id FROM agents WHERE user_slot=?').all(slot);
  const arch = db.prepare('UPDATE agents SET status=?, updated_at=? WHERE user_slot=? AND agent_id=?');
  for (const r of exist) {
    if (!known.has(r.agent_id)) arch.run('archived', ts, slot, r.agent_id);
  }
  return rows.length;
}

function upsertAllAgents(db) {
  let total = 0;
  for (let n = 1; n <= 99; n++) {
    const slot = String(n).padStart(2, '0');
    if (!fs.existsSync(path.join(DATA_ROOT, `user${slot}`))) continue;
    total += upsertAgentsForSlot(db, slot);
  }
  return total;
}

module.exports = { upsertAgentsForSlot, upsertAllAgents };
