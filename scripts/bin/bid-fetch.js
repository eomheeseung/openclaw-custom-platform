#!/usr/bin/env node
// bid.tideflo.work 읽기 헬퍼 — 컨테이너 내부에서 Chrome CDP 쿠키로 HTTPS 호출
// 사용: node bid-fetch.js <action> [args...]
//   list <status>           → /bids?status=<status> HTML → [{bidRowId, preview}]
//   detail <bidRowId>       → /bids/<id>   HTML → {title, bidNo, documents:[{docId,name}]}
//   document <docId>        → /documents/<docId>/md 원문
//   assigned                → list + 각 detail + 각 document 종합

const http = require('http');
const https = require('https');

const BID_HOST = 'bid.tideflo.work';
const CDP_HOST = '127.0.0.1';
const CDP_PORT = 18800;

function cdpPageWs() {
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const targets = JSON.parse(d);
          const page = targets.find(t => t.type === 'page');
          if (!page) return reject(new Error('no page target open'));
          resolve(page.webSocketDebuggerUrl);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function cdpCall(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })));
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data.toString());
        if (msg.id === id) { ws.close(); resolve(msg); }
      } catch {}
    });
    ws.addEventListener('error', (e) => reject(e.error || new Error('ws error')));
    setTimeout(() => { try { ws.close(); } catch {} reject(new Error('ws timeout')); }, 8000);
  });
}

async function getCookie() {
  const wsUrl = await cdpPageWs();
  const r = await cdpCall(wsUrl, 'Storage.getCookies');
  const cookies = (r?.result?.cookies || []).filter(c => (c.domain || '').includes(BID_HOST));
  if (cookies.length === 0) throw new Error('bid.tideflo.work 쿠키 없음 (VNC로 로그인 필요)');
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function httpsGet(path, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BID_HOST, port: 443, path, method: 'GET',
      headers: { Cookie: cookie, 'User-Agent': 'OpenClaw-BidFetch/1.0' },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('https timeout')); });
    req.end();
  });
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x20/g, ' ');
}

function parseList(html) {
  const bids = [];
  const rx = /<a[^>]+href="\/bids\/(\d+)"[^>]*>([\s\S]{0,500}?)<\/a>/g;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const id = m[1];
    const inner = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!bids.find(b => b.bidRowId === id)) bids.push({ bidRowId: id, preview: inner.slice(0, 200) });
  }
  return bids;
}

function parseDetail(html) {
  const docs = [];
  const rx = /openDocViewer\s*\(\s*(\d+)\s*,\s*'([^']+)'\s*,\s*&quot;([\s\S]*?)&quot;/g;
  const seen = new Set();
  let m;
  while ((m = rx.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    docs.push({ docId: id, name: decodeEntities(m[3]) });
  }
  const title = (html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/) || [])[1]?.replace(/<[^>]+>/g, '').trim() || '';
  const bidNo = (html.match(/R[0-9A-Z]{10,}/) || [])[0] || '';
  return { title, bidNo, documents: docs };
}

async function cdpBidPage() {
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const targets = JSON.parse(d);
          const bidPage = targets.find(t => t.type === 'page' && (t.url || '').includes(BID_HOST));
          const anyPage = targets.find(t => t.type === 'page');
          resolve(bidPage || anyPage || null);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function logoutBid() {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  const anyPage = targets.find(t => t.type === 'page');
  if (!anyPage) throw new Error('no page target to clear cookies');

  const wsUrl = anyPage.webSocketDebuggerUrl;
  const ck = await cdpCall(wsUrl, 'Storage.getCookies');
  const cookies = (ck?.result?.cookies || []).filter(c => (c.domain || '').includes(BID_HOST));
  let deleted = 0;
  for (const c of cookies) {
    await cdpCall(wsUrl, 'Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path || '/' });
    deleted++;
  }
  try {
    await cdpCall(wsUrl, 'Storage.clearDataForOrigin', {
      origin: `https://${BID_HOST}`,
      storageTypes: 'cookies,local_storage,session_storage,indexeddb',
    });
  } catch {}

  const bidTabs = targets.filter(t => t.type === 'page' && (t.url || '').includes(BID_HOST));
  for (const tab of bidTabs) {
    try { await cdpCall(tab.webSocketDebuggerUrl, 'Page.navigate', { url: `https://${BID_HOST}/login` }); } catch {}
  }
  return { ok: true, deletedCookies: deleted, navigated: bidTabs.length };
}

async function main() {
  const [, , action, ...args] = process.argv;
  try {
    if (action === 'logout') {
      const r = await logoutBid();
      process.stdout.write(JSON.stringify(r));
      return;
    }
    const cookie = await getCookie();
    if (action === 'list') {
      const status = args[0] || '';
      const q = status ? `?status=${encodeURIComponent(status)}` : '';
      const r = await httpsGet(`/bids${q}`, cookie);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      process.stdout.write(JSON.stringify({ ok: true, bids: parseList(r.body) }));
    } else if (action === 'detail') {
      const id = args[0];
      if (!id) throw new Error('bidRowId required');
      const r = await httpsGet(`/bids/${id}`, cookie);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      process.stdout.write(JSON.stringify({ ok: true, ...parseDetail(r.body) }));
    } else if (action === 'document') {
      const id = args[0];
      if (!id) throw new Error('docId required');
      const r = await httpsGet(`/documents/${id}/md`, cookie);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      process.stdout.write(JSON.stringify({ ok: true, docId: id, markdown: r.body }));
    } else if (action === 'assigned') {
      const lr = await httpsGet('/bids?status=assigned', cookie);
      if (lr.status !== 200) throw new Error(`list HTTP ${lr.status}`);
      const bids = parseList(lr.body);
      const result = [];
      for (const b of bids) {
        try {
          const dr = await httpsGet(`/bids/${b.bidRowId}`, cookie);
          const det = parseDetail(dr.body);
          const docs = [];
          for (const doc of det.documents) {
            try {
              const mr = await httpsGet(`/documents/${doc.docId}/md`, cookie);
              // 문서당 최대 60KB (약 15K 토큰). 4 bids × 3 docs ≈ 45K 토큰으로 kimi 128K 컨텍스트 여유.
              docs.push({ docId: doc.docId, name: doc.name, markdown: (mr.body || '').slice(0, 60000) });
            } catch (e) { docs.push({ docId: doc.docId, name: doc.name, error: e.message }); }
          }
          result.push({ bidRowId: b.bidRowId, bidNo: det.bidNo, title: det.title, preview: b.preview, documents: docs });
        } catch (e) { result.push({ bidRowId: b.bidRowId, preview: b.preview, error: e.message }); }
      }
      process.stdout.write(JSON.stringify({ ok: true, count: result.length, bids: result }));
    } else if (action === 'queue_summarize') {
      const detail = args[0] || 'normal';
      const concurrency = parseInt(args[1] || '3', 10);
      const cap = detail === 'deep' ? 60000 : detail === 'detailed' ? 35000 : 20000;
      const lines = detail === 'deep' ? '100줄+' : detail === 'detailed' ? '60~80줄' : '30~40줄';
      const bullets = detail === 'deep' ? '15개+' : detail === 'detailed' ? '12~15개' : '7~10개';
      /* multi-key + multi-model: k2.6(큐 한산) 우선, 다 fail이면 k2.5 fallback */
      const moonshotKeys = (process.env.MOONSHOT_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
      const primaryKey = (process.env.MOONSHOT_API_KEY || '').trim();
      const keys = moonshotKeys.length > 0 ? moonshotKeys : (primaryKey ? [primaryKey] : []);
      if (keys.length === 0) throw new Error('MOONSHOT_API_KEY missing');
      const MODELS_PRIORITY = ['kimi-k2.6', 'kimi-k2.5'];

      const callOnce = (prompt, model, apiKey) => new Promise((resolve, reject) => {
        /* k2.6은 reasoning 사용해서 max_tokens 더 필요 */
        const maxTokens = model === 'kimi-k2.6' ? 6000 : 4000;
        const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 1 });
        const req = https.request({ hostname: 'api.moonshot.ai', port: 443, path: '/v1/chat/completions', method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => {
            try {
              const j = JSON.parse(d);
              if (j.error) {
                const err = new Error(`moonshot ${res.statusCode}: ${j.error.message || JSON.stringify(j.error)}`);
                err.statusCode = res.statusCode;
                return reject(err);
              }
              const c = j.choices?.[0]?.message;
              const text = (c?.content || c?.reasoning_content || '').trim();
              if (!text) return reject(new Error(`empty response raw=${d.slice(0, 200)}`));
              resolve(text);
            } catch (e) { reject(new Error(`parse: ${e.message}`)); }
          });
        });
        req.setTimeout(180000, () => { req.destroy(); reject(new Error('moonshot timeout')); });
        req.on('error', reject);
        req.write(body); req.end();
      });

      const callMoonshot = async (prompt) => {
        let lastError = null;
        for (const model of MODELS_PRIORITY) {
          for (const apiKey of keys) {
            try {
              return await callOnce(prompt, model, apiKey);
            } catch (e) {
              lastError = e;
              const status = e.statusCode || 0;
              /* 429/401/403 → 다음 키. 다른 에러는 이 모델 포기 + 다음 모델 */
              if (status === 429 || status === 401 || status === 403) continue;
              break;
            }
          }
        }
        throw lastError || new Error('all moonshot attempts failed');
      };

      const lr = await httpsGet('/bids?status=assigned', cookie);
      if (lr.status !== 200) throw new Error(`list HTTP ${lr.status}`);
      const bids = parseList(lr.body);

      const started = Date.now();
      const tasks = bids.map(b => async () => {
        const t0 = Date.now();
        try {
          const dr = await httpsGet(`/bids/${b.bidRowId}`, cookie);
          const det = parseDetail(dr.body);
          const docs = [];
          for (const doc of det.documents) {
            try {
              const mr = await httpsGet(`/documents/${doc.docId}/md`, cookie);
              docs.push({ name: doc.name, markdown: (mr.body || '').slice(0, cap) });
            } catch (e) { docs.push({ name: doc.name, error: e.message }); }
          }
          const docText = docs.map(x => `## ${x.name}\n${x.markdown || '(no content: ' + x.error + ')'}`).join('\n\n---\n\n');
          const prompt = `다음 입찰공고를 ${lines} 분량으로 아래 구조에 맞춰 한국어로 요약 (생략·축약 금지, 불릿 완전히 작성):

[사업명: ${det.title} / 공고번호: ${det.bidNo} / bidRowId: ${b.bidRowId}]
- 발주기관 / 예산 / 마감일
- 사업 개요 (1~2단락)
- 핵심 기술 요구사항 (불릿 ${bullets})
- 평가 기준·배점표
- 제출 서류 체크리스트
- 우리 회사 적합도 분석
- 리스크·질의사항

**문서 내용**:
${docText}`;
          const summary = await callMoonshot(prompt);
          return { bidRowId: b.bidRowId, bidNo: det.bidNo, title: det.title, preview: b.preview, summary, elapsedMs: Date.now() - t0 };
        } catch (e) {
          return { bidRowId: b.bidRowId, preview: b.preview, error: e.message, elapsedMs: Date.now() - t0 };
        }
      });

      const results = new Array(tasks.length);
      let rIdx = 0;
      const workers = Array(Math.min(concurrency, tasks.length)).fill(0).map(async () => {
        while (true) {
          const i = rIdx++;
          if (i >= tasks.length) return;
          results[i] = await tasks[i]();
        }
      });
      await Promise.all(workers);
      process.stdout.write(JSON.stringify({ ok: true, count: results.length, concurrency, detail, totalElapsedMs: Date.now() - started, bids: results }));
    } else {
      throw new Error(`unknown action: ${action}`);
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}

main();
