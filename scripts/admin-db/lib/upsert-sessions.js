const fs = require('fs');
const path = require('path');
const { now } = require('./db');

const DATA_ROOT = '/opt/openclaw/data';

function upsertSessionsForAgent(db, slot, agentId) {
  const sessionsJson = path.join(DATA_ROOT, `user${slot}`, 'agents', agentId, 'sessions', 'sessions.json');
  if (!fs.existsSync(sessionsJson)) return 0;
  let data;
  try { data = JSON.parse(fs.readFileSync(sessionsJson, 'utf8')); } catch { return 0; }
  const sessionsDir = path.dirname(sessionsJson);
  const ts = now();

  const agentRow = db.prepare('SELECT id FROM agents WHERE user_slot=? AND agent_id=?').get(slot, agentId);
  const agent_db_id = agentRow ? agentRow.id : null;

  const stmt = db.prepare(`
    INSERT INTO sessions (session_key, user_slot, agent_db_id, agent_id, status, is_main, message_count, total_tokens, total_cost_krw, file_path, created_at, last_active_at, updated_at)
    VALUES (@session_key, @user_slot, @agent_db_id, @agent_id, @status, @is_main, @message_count, @total_tokens, @total_cost_krw, @file_path, @created_at, @last_active_at, @ts)
    ON CONFLICT(session_key) DO UPDATE SET
      agent_db_id = excluded.agent_db_id,
      status = excluded.status,
      message_count = excluded.message_count,
      total_tokens = excluded.total_tokens,
      total_cost_krw = excluded.total_cost_krw,
      file_path = excluded.file_path,
      last_active_at = excluded.last_active_at,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r); });

  const rows = Object.entries(data).map(([sessionKey, meta]) => {
    const tail = sessionKey.split(':').pop() || '';
    const sessionFile = (meta && meta.sessionFile) || `${sessionsDir}/${tail}.jsonl`;
    let mtime = ts;
    try { if (fs.existsSync(sessionFile)) mtime = Math.floor(fs.statSync(sessionFile).mtimeMs); } catch { /* ignore */ }
    return {
      session_key: sessionKey,
      user_slot: slot,
      agent_db_id,
      agent_id: agentId,
      status: meta?.status || 'active',
      is_main: tail === 'main' ? 1 : 0,
      message_count: meta?.messageCount || 0,
      total_tokens: meta?.totalTokens || 0,
      total_cost_krw: 0,
      file_path: sessionFile,
      created_at: meta?.createdAt || mtime,
      last_active_at: meta?.updatedAt || mtime,
      ts,
    };
  });
  tx(rows);
  return rows.length;
}

function upsertAllSessions(db) {
  let total = 0;
  for (let n = 1; n <= 99; n++) {
    const slot = String(n).padStart(2, '0');
    const userDir = path.join(DATA_ROOT, `user${slot}`, 'agents');
    if (!fs.existsSync(userDir)) continue;
    for (const ag of fs.readdirSync(userDir)) {
      total += upsertSessionsForAgent(db, slot, ag);
    }
  }
  return total;
}

module.exports = { upsertSessionsForAgent, upsertAllSessions };
