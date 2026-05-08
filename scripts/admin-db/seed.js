const { openDb } = require('./lib/db');
const { upsertUsers } = require('./lib/upsert-users');
const { upsertAllAgents } = require('./lib/upsert-agents');
const { upsertAllSessions } = require('./lib/upsert-sessions');
const { upsertAllUsage } = require('./lib/upsert-usage');
const { upsertFxFromConfig } = require('./lib/upsert-fx');

(function main() {
  const db = openDb();
  const t0 = Date.now();
  const stats = {
    users: upsertUsers(db),
    agents: upsertAllAgents(db),
    sessions: upsertAllSessions(db),
    usage: upsertAllUsage(db),
    fx: upsertFxFromConfig(db),
  };
  const elapsed = Date.now() - t0;
  console.log(`[seed] done in ${elapsed}ms`, stats);
  console.log('[seed] table counts:', {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    agents: db.prepare('SELECT COUNT(*) c FROM agents').get().c,
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    usage: db.prepare('SELECT COUNT(*) c FROM api_usage_daily').get().c,
    fx: db.prepare('SELECT COUNT(*) c FROM fx_rates').get().c,
  });
  db.close();
})();
