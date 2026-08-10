#!/usr/bin/env node
/* user01~15 메모리 DB 일괄 초기화 (idempotent). */
const { openMemoryDb, dbPathFor } = require('./lib/db');

const slots = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, '0'));

let okCount = 0;
let errCount = 0;
for (const nn of slots) {
  try {
    const db = openMemoryDb(nn);
    const meta = db.prepare('SELECT value FROM _meta WHERE key = ?').get('schema_version');
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM memories').get();
    console.log(`[user${nn}] OK schema=v${meta?.value || '?'} memories=${cnt.n} path=${dbPathFor(nn)}`);
    okCount++;
  } catch (err) {
    console.error(`[user${nn}] FAIL: ${err.message}`);
    errCount++;
  }
}
console.log(`\nDone: ${okCount} ok / ${errCount} fail`);
process.exit(errCount > 0 ? 1 : 0);
