const path = require('path');
const chokidar = require('chokidar');
const { openDb } = require('./lib/db');
const { upsertUsers } = require('./lib/upsert-users');
const { upsertAgentsForSlot } = require('./lib/upsert-agents');
const { upsertSessionsForAgent } = require('./lib/upsert-sessions');
const { upsertUsageFile } = require('./lib/upsert-usage');
const { upsertFxFromConfig } = require('./lib/upsert-fx');

const PATHS = {
  users: '/opt/openclaw/auth/users.json',
  fx: '/opt/openclaw/config/usage-pricing.json',
  dataRoot: '/opt/openclaw/data',
  usageRoot: '/opt/openclaw/data/usage',
};

const debounceMap = new Map();
function debounce(key, fn, ms = 300) {
  if (debounceMap.has(key)) clearTimeout(debounceMap.get(key));
  debounceMap.set(key, setTimeout(() => {
    debounceMap.delete(key);
    try { fn(); } catch (e) { console.error('[watcher]', key, e.message); }
  }, ms));
}

function startWatcher(existingDb) {
  const db = existingDb || openDb();
  console.log('[watcher] DB ready, starting chokidar...');

  const onUsersJson = () => debounce('users', () => {
    console.log('[watcher] users.json changed → UPSERT');
    upsertUsers(db);
  });
  const onFxConfig = () => debounce('fx', () => {
    console.log('[watcher] pricing.json changed → fx UPSERT');
    upsertFxFromConfig(db);
  });

  const onDataChange = (filePath) => {
    const rel = path.relative(PATHS.dataRoot, filePath);
    const m = rel.match(/^user(\d{2})[\\/](.+)$/);
    if (!m) return;
    const slot = m[1];
    const sub = m[2].replace(/\\/g, '/');
    if (sub === 'openclaw.json') {
      debounce(`agents:${slot}`, () => {
        console.log(`[watcher] user${slot} openclaw.json → agents UPSERT`);
        upsertAgentsForSlot(db, slot);
      });
      return;
    }
    const sm = sub.match(/^agents\/([^/]+)\/sessions\/(sessions\.json|.+\.jsonl)$/);
    if (sm) {
      const agentId = sm[1];
      debounce(`sessions:${slot}:${agentId}`, () => {
        console.log(`[watcher] user${slot}/${agentId} sessions changed → UPSERT`);
        upsertSessionsForAgent(db, slot, agentId);
      });
    }
  };

  const onUsageChange = (filePath) => {
    const rel = path.relative(PATHS.usageRoot, filePath);
    const m = rel.match(/^user(\d{2})[\\/](\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) return;
    const [, slot, dateStr] = m;
    debounce(`usage:${slot}:${dateStr}`, () => {
      console.log(`[watcher] user${slot} usage ${dateStr} → UPSERT`);
      upsertUsageFile(db, slot, dateStr);
    });
  };

  chokidar.watch(PATHS.users, { ignoreInitial: true }).on('all', onUsersJson);
  chokidar.watch(PATHS.fx, { ignoreInitial: true }).on('all', onFxConfig);
  chokidar.watch(PATHS.dataRoot + '/user*/openclaw.json', { ignoreInitial: true }).on('all', (_, p) => onDataChange(p));
  chokidar.watch(PATHS.dataRoot + '/user*/agents/*/sessions/sessions.json', { ignoreInitial: true }).on('all', (_, p) => onDataChange(p));
  chokidar.watch(PATHS.dataRoot + '/user*/agents/*/sessions/*.jsonl', { ignoreInitial: true }).on('all', (_, p) => onDataChange(p));
  chokidar.watch(PATHS.usageRoot + '/user*/*.json', { ignoreInitial: true }).on('all', (_, p) => onUsageChange(p));

  console.log('[watcher] watching');
  return db;
}

if (require.main === module) startWatcher();

module.exports = { startWatcher };
