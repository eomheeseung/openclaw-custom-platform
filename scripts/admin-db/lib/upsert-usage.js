const fs = require('fs');
const path = require('path');
const { now } = require('./db');

const USAGE_ROOT = '/opt/openclaw/data/usage';

function upsertUsageFile(db, slot, dateStr) {
  const f = path.join(USAGE_ROOT, `user${slot}`, `${dateStr}.json`);
  if (!fs.existsSync(f)) return 0;
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return 0; }
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO api_usage_daily (user_slot, date, model, input_tokens, output_tokens, cache_read, cache_write, message_count, cost_usd, cost_krw, fx_rate, updated_at)
    VALUES (@user_slot, @date, @model, @input_tokens, @output_tokens, @cache_read, @cache_write, @message_count, @cost_usd, @cost_krw, @fx_rate, @ts)
    ON CONFLICT(user_slot, date, model) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write,
      message_count = excluded.message_count,
      cost_usd = excluded.cost_usd,
      cost_krw = excluded.cost_krw,
      fx_rate = excluded.fx_rate,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r); });
  // 실제 파일 형식: { models: { 'kimi-k2.6': { input, output, cacheRead, cacheWrite, totalTokens, messageCount, costUsd } }, costKrw, costUsd, totalTokens, messageCount }
  // costKrw가 모델별이 아닌 top-level이라, 모델 1개일 때만 그 값을 그 모델에 귀속. 여러 모델이면 token 비례 분배.
  const models = data.models || data.byModel || {};
  const totalCostKrw = data.costKrw || 0;
  const totalTokens = data.totalTokens || 0;
  const fx = data.fx || data.fxRate || null;
  const rows = Object.entries(models).map(([model, m]) => {
    const tokens = m.totalTokens || ((m.input || 0) + (m.output || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0));
    const ratio = totalTokens > 0 ? tokens / totalTokens : (Object.keys(models).length === 1 ? 1 : 0);
    return {
      user_slot: slot, date: dateStr, model,
      input_tokens: m.input || 0,
      output_tokens: m.output || 0,
      cache_read: m.cacheRead || 0,
      cache_write: m.cacheWrite || 0,
      message_count: m.messageCount || m.messages || 0,
      cost_usd: m.costUsd || 0,
      cost_krw: m.costKrw || (totalCostKrw * ratio),
      fx_rate: fx,
      ts,
    };
  });
  tx(rows);
  return rows.length;
}

function upsertAllUsage(db) {
  if (!fs.existsSync(USAGE_ROOT)) return 0;
  let total = 0;
  for (const userDir of fs.readdirSync(USAGE_ROOT)) {
    const m = userDir.match(/^user(\d{2})$/);
    if (!m) continue;
    const slot = m[1];
    const dir = path.join(USAGE_ROOT, userDir);
    for (const file of fs.readdirSync(dir)) {
      const dm = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!dm) continue;
      total += upsertUsageFile(db, slot, dm[1]);
    }
  }
  return total;
}

module.exports = { upsertUsageFile, upsertAllUsage };
