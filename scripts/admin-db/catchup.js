// Phase 1 단순 구현: 모든 매핑 파일에 대해 무조건 UPSERT 호출. 멱등.
// (mtime 비교 최적화는 Phase 2 — 지금 규모(수백 row)에선 단순 일괄이 빠르고 안전)
const { openDb } = require('./lib/db');
const { upsertUsers } = require('./lib/upsert-users');
const { upsertAllAgents } = require('./lib/upsert-agents');
const { upsertAllSessions } = require('./lib/upsert-sessions');
const { upsertAllUsage } = require('./lib/upsert-usage');
const { upsertFxFromConfig } = require('./lib/upsert-fx');

function catchup(dbOpt) {
  const ownDb = !dbOpt;
  const db = dbOpt || openDb();
  const t0 = Date.now();
  const stats = {
    users: upsertUsers(db),
    agents: upsertAllAgents(db),
    sessions: upsertAllSessions(db),
    usage: upsertAllUsage(db),
    fx: upsertFxFromConfig(db),
  };
  console.log(`[catchup] ${Date.now() - t0}ms`, stats);
  if (ownDb) db.close();
  return stats;
}

if (require.main === module) catchup();

module.exports = { catchup };
