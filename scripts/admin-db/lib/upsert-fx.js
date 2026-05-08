const fs = require('fs');
const { now } = require('./db');

const PRICING = '/opt/openclaw/config/usage-pricing.json';

function upsertFxFromConfig(db) {
  if (!fs.existsSync(PRICING)) return 0;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(PRICING, 'utf8')); } catch { return 0; }
  const fx = cfg.fx;
  if (!fx || !fx.usdToKrw) return 0;
  const fetchedAt = fx.updatedAt ? Date.parse(fx.updatedAt) : now();
  // 같은 currency + fetched_at이 이미 있으면 skip (스냅샷 누적)
  const exist = db.prepare('SELECT id FROM fx_rates WHERE currency=? AND fetched_at=?').get('USD', fetchedAt);
  if (exist) return 0;
  db.prepare(`
    INSERT INTO fx_rates (currency, to_currency, rate, fetched_at, source)
    VALUES ('USD', 'KRW', ?, ?, ?)
  `).run(fx.usdToKrw, fetchedAt, 'config:usage-pricing.json');
  return 1;
}

module.exports = { upsertFxFromConfig };
