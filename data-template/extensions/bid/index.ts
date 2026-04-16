// @ts-nocheck
// Bid Plugin — bid.tideflo.work 읽기 전용 통합
// Chrome CDP에서 ci_session 쿠키 추출 → bid.tideflo.work HTML 스크랩 + markdown 엔드포인트

const http = require('http');
const https = require('https');

const BID_HOST = 'bid.tideflo.work';
const CDP_HOST = '127.0.0.1';
const CDP_PORT = 18800;

// --- Chrome CDP로 쿠키 추출 ---
async function getCdpTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('CDP /json parse fail')); } });
    }).on('error', reject);
  });
}

function cdpWsCall(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    ws.addEventListener('open', () => { ws.send(JSON.stringify({ id, method, params })); });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data.toString());
        if (msg.id === id) { ws.close(); resolve(msg); }
      } catch (e) { /* ignore */ }
    });
    ws.addEventListener('error', (e) => reject(e.error || new Error('CDP ws error')));
    setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP ws timeout')); }, 10000);
  });
}

async function getBidCookieHeader() {
  // page target을 찾아서 Storage.getCookies 호출 (browser-level Network.getAllCookies는 0 반환)
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', async () => {
        try {
          const targets = JSON.parse(data);
          const page = targets.find(t => t.type === 'page');
          if (!page) return reject(new Error('no page target (VNC에서 Chrome 탭 열려있어야 함)'));
          const r = await cdpWsCall(page.webSocketDebuggerUrl, 'Storage.getCookies');
          const cookies = r?.result?.cookies || [];
          const bidCookies = cookies.filter(c => (c.domain || '').includes(BID_HOST));
          if (bidCookies.length === 0) return reject(new Error(`bid.tideflo.work 쿠키 없음. VNC로 먼저 로그인 필요.`));
          const header = bidCookies.map(c => `${c.name}=${c.value}`).join('; ');
          resolve(header);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// --- HTTPS GET with Cookie ---
function httpsGet(path, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BID_HOST, port: 443, path, method: 'GET',
      headers: { 'Cookie': cookie, 'User-Agent': 'OpenClaw-BidPlugin/1.0', 'Accept': 'text/html,text/markdown,*/*' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('HTTPS timeout')); });
    req.end();
  });
}

// --- HTML 파싱 헬퍼 ---
function parseBidsListPage(html) {
  const bids = [];
  // <a href="/bids/3331">...</a> 패턴에서 ID 추출, 주변 텍스트에서 bidNo/title
  const rowRx = /<a[^>]+href="\/bids\/(\d+)"[^>]*>([\s\S]{0,500}?)<\/a>/g;
  let m;
  while ((m = rowRx.exec(html)) !== null) {
    const bidRowId = m[1];
    const inner = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!bids.find(b => b.bidRowId === bidRowId)) bids.push({ bidRowId, preview: inner.slice(0, 200) });
  }
  return bids;
}

function parseDetailPage(html) {
  const docs = [];
  const callRx = /openDocViewer\s*\(\s*(\d+)\s*,\s*'([^']+)'\s*,\s*&quot;([\s\S]*?)&quot;/g;
  const seen = new Set();
  let m;
  while ((m = callRx.exec(html)) !== null) {
    const docId = m[1];
    if (seen.has(docId)) continue;
    seen.add(docId);
    const nameEnc = m[3];
    const name = decodeHtmlEntities(nameEnc);
    docs.push({ docId, name });
  }
  // 기본 메타: 제목, 상태, 마감일 등
  const title = (html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/) || [])[1]?.replace(/<[^>]+>/g, '').trim() || '';
  const bidNo = (html.match(/R[0-9A-Z]{10,}/) || [])[0] || '';
  return { title, bidNo, documents: docs };
}

function decodeHtmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x20/g, ' ');
}

// --- 도구 함수 ---
async function listBids(status) {
  const cookie = await getBidCookieHeader();
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await httpsGet(`/bids${q}`, cookie);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return parseBidsListPage(res.body);
}

async function detailBid(bidRowId) {
  const cookie = await getBidCookieHeader();
  const res = await httpsGet(`/bids/${bidRowId}`, cookie);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return parseDetailPage(res.body);
}

async function fetchDocMarkdown(docId) {
  const cookie = await getBidCookieHeader();
  const res = await httpsGet(`/documents/${docId}/md`, cookie);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.body;
}

const json = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });

const bidPlugin = {
  id: 'bid',
  name: 'Bid (bid.tideflo.work)',
  description: 'bid.tideflo.work 입찰공고 관리 시스템 읽기 전용 통합.',

  configSchema: {
    parse(value) {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true };
    },
    uiHints: { enabled: { label: 'Enable Bid Tools' } },
  },

  register(api) {
    if (api.pluginConfig?.enabled === false) return;
    console.log('[plugins] Bid tools registered: bid_list, bid_detail, bid_document_text, bid_summarize_assigned');

    api.registerTool({
      name: 'bid_list',
      label: '입찰공고 목록',
      description: 'bid.tideflo.work에서 상태별 입찰공고 목록 조회. "assigned" = 할당됨, "go" = 진행, "nogo" = 포기, "reviewing" = 검토중, "won" = 수주, "lost" = 실주, "submitted" = 제출완료, "new" = 신규, "pass" = 패스, "in_progress" = 진행중. 없으면 전체.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '상태 필터. 비우면 전체.' },
        },
      },
      async execute(_, params) {
        try { return json({ ok: true, bids: await listBids(params?.status || '') }); }
        catch (e) { return json({ ok: false, error: e.message + ' (VNC로 bid.tideflo.work 로그인 필요할 수 있음)' }); }
      },
    });

    api.registerTool({
      name: 'bid_detail',
      label: '입찰공고 상세',
      description: '특정 입찰공고의 상세 정보와 문서 목록 조회.',
      parameters: {
        type: 'object', required: ['bidRowId'],
        properties: { bidRowId: { type: 'string', description: 'bid 행 ID (bid_list 결과의 bidRowId)' } },
      },
      async execute(_, params) {
        try { return json({ ok: true, ...(await detailBid(params.bidRowId)) }); }
        catch (e) { return json({ ok: false, error: e.message }); }
      },
    });

    api.registerTool({
      name: 'bid_document_text',
      label: '입찰 문서 텍스트',
      description: 'bid.tideflo.work의 특정 문서를 markdown 텍스트로 가져옴. PDF도 서버에서 이미 변환돼있음.',
      parameters: {
        type: 'object', required: ['docId'],
        properties: { docId: { type: 'string', description: 'bid_detail의 documents[].docId' } },
      },
      async execute(_, params) {
        try {
          const md = await fetchDocMarkdown(params.docId);
          return json({ ok: true, docId: params.docId, length: md.length, markdown: md });
        } catch (e) { return json({ ok: false, error: e.message }); }
      },
    });

    // --- 내부 큐 기반 병렬 요약 (B-1: 플러그인이 moonshot API 직접 호출) ---
    async function callLLM(prompt, apiKey, maxTokens = 4000) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify({
          model: 'kimi-k2.5',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 1,
        });
        const req = https.request({
          hostname: 'api.moonshot.ai', port: 443, path: '/v1/chat/completions', method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const d = JSON.parse(data);
              if (d.error) return reject(new Error(`kimi ${res.statusCode}: ${d.error.message || JSON.stringify(d.error)}`));
              const c = d.choices?.[0]?.message;
              const text = (c?.content || c?.reasoning_content || '').trim();
              if (!text) return reject(new Error(`kimi empty response, raw=${data.slice(0, 300)}`));
              resolve(text);
            } catch (e) { reject(new Error(`kimi parse: ${e.message} raw=${data.slice(0, 200)}`)); }
          });
        });
        req.setTimeout(180000, () => { req.destroy(); reject(new Error('kimi timeout')); });
        req.on('error', reject);
        req.write(body); req.end();
      });
    }

    async function pLimit(n, tasks) {
      const results = new Array(tasks.length);
      let i = 0;
      const workers = Array(Math.min(n, tasks.length)).fill(0).map(async () => {
        while (true) {
          const idx = i++;
          if (idx >= tasks.length) return;
          try { results[idx] = await tasks[idx](); }
          catch (e) { results[idx] = { error: e.message }; }
        }
      });
      await Promise.all(workers);
      return results;
    }

    api.registerTool({
      name: 'bid_queue_summarize',
      label: '배정 입찰 병렬 요약 (큐)',
      description: '오늘 배정된 모든 입찰공고를 **내부 큐로 동시 3개 병렬 요약**. 플러그인이 각 bid마다 상세/문서 조회 + LLM 요약을 p-limit(3)로 실행. 비서는 이 도구 1번만 호출하고 결과를 사용자에게 그대로 전달하면 됨. sessions_spawn·배치 로직 불필요.',
      parameters: {
        type: 'object',
        properties: {
          detail: { type: 'string', enum: ['normal', 'detailed', 'deep'], description: '문서 크기: normal=20KB, detailed=35KB, deep=60KB' },
          concurrency: { type: 'number', description: '동시 처리 개수 (기본 3)' },
        },
      },
      async execute(_, params) {
        const apiKey = process.env.MOONSHOT_API_KEY;
        if (!apiKey) return json({ ok: false, error: 'MOONSHOT_API_KEY env 미설정' });
        const cap = params?.detail === 'deep' ? 60000 : params?.detail === 'detailed' ? 35000 : 20000;
        const targetChars = params?.detail === 'deep' ? 5000 : params?.detail === 'detailed' ? 3000 : 1500;
        const maxTokens = params?.detail === 'deep' ? 8000 : params?.detail === 'detailed' ? 5000 : 2500;
        const bullets = params?.detail === 'deep' ? '15개 이상' : params?.detail === 'detailed' ? '12~15개' : '7~10개';
        const concurrency = params?.concurrency || 3;

        let bids;
        try { bids = await listBids('assigned'); }
        catch (e) { return json({ ok: false, error: e.message + ' (VNC로 bid.tideflo.work 로그인 필요)' }); }

        const started = Date.now();
        const tasks = bids.map(b => async () => {
          const t0 = Date.now();
          const d = await detailBid(b.bidRowId);
          const docs = [];
          for (const doc of d.documents) {
            try { docs.push({ name: doc.name, markdown: (await fetchDocMarkdown(doc.docId)).slice(0, cap) }); }
            catch (de) { docs.push({ name: doc.name, error: de.message }); }
          }
          const docText = docs.map(x => `## ${x.name}\n${x.markdown || '(no content: ' + x.error + ')'}`).join('\n\n---\n\n');
          const prompt = `다음 입찰공고를 **정확히 ${targetChars}자 이상** 분량으로 아래 구조에 맞춰 한국어로 상세 요약.

**반드시 지킬 것**:
- 총 분량 ${targetChars}자 이상 (미달 시 각 섹션 더 구체화해서 채워. 추상적 "~등 다수" 금지, 구체 명시)
- 각 불릿은 1~2문장 완결형 (단어 나열 금지)
- 문서에 있는 **구체 수치·날짜·기관명·조건** 최대한 포함
- 축약·생략·"..." 표기 금지

**구조**:
[사업명: ${d.title} / 공고번호: ${d.bidNo} / bidRowId: ${b.bidRowId}]

1. 발주기관 / 예산 / 마감일 / 계약기간 (구체 수치·일시)
2. 사업 개요 (${Math.floor(targetChars*0.15)}자 이상, 배경·목적·범위 포함)
3. 핵심 기술 요구사항 (불릿 ${bullets}, 각 불릿 50자 이상)
4. 평가 기준·배점표 (세부 평가항목·배점 명시)
5. 제출 서류 체크리스트 (누락 없이 전부 나열)
6. 우리 회사 적합도 분석 (${Math.floor(targetChars*0.12)}자 이상, 강점·약점·준비 필요 사항)
7. 리스크·질의사항 (${Math.floor(targetChars*0.12)}자 이상, 각 리스크 구체 시나리오)

**문서 내용**:
${docText}`;
          const summary = await callLLM(prompt, apiKey, maxTokens);
          return { bidRowId: b.bidRowId, bidNo: d.bidNo, title: d.title, preview: b.preview, summary, elapsedMs: Date.now() - t0 };
        });

        const results = await pLimit(concurrency, tasks);
        return json({ ok: true, count: results.length, concurrency, totalElapsedMs: Date.now() - started, bids: results });
      },
    });

    api.registerTool({
      name: 'bid_queue_summarize_batch',
      label: '입찰 배치 요약 (지정 ID)',
      description: '지정된 bidRowId 목록만 병렬 LLM 요약. bid_queue_summarize를 배치별로 나눠 호출할 때 사용. 배치당 2~3개 권장. 결과를 즉시 사용자에게 출력하고 다음 배치 호출.',
      parameters: {
        type: 'object',
        required: ['bidRowIds'],
        properties: {
          bidRowIds: { type: 'array', items: { type: 'string' }, description: '요약할 bidRowId 배열 (배치당 2~3개 권장)' },
          detail: { type: 'string', enum: ['normal', 'detailed', 'deep'], description: 'normal=1500자/20KB, detailed=3000자/35KB, deep=5000자/60KB' },
        },
      },
      async execute(_, params) {
        const apiKey = process.env.MOONSHOT_API_KEY;
        if (!apiKey) return json({ ok: false, error: 'MOONSHOT_API_KEY 미설정' });
        const bidRowIds = params?.bidRowIds || [];
        if (!bidRowIds.length) return json({ ok: false, error: 'bidRowIds 필요' });

        const cap = params?.detail === 'deep' ? 60000 : params?.detail === 'detailed' ? 35000 : 20000;
        const targetChars = params?.detail === 'deep' ? 5000 : params?.detail === 'detailed' ? 3000 : 1500;
        const maxTokens = params?.detail === 'deep' ? 8000 : params?.detail === 'detailed' ? 5000 : 2500;
        const bullets = params?.detail === 'deep' ? '15개 이상' : params?.detail === 'detailed' ? '12~15개' : '7~10개';

        const started = Date.now();
        let allBids;
        try { allBids = await listBids('assigned'); }
        catch (e) { return json({ ok: false, error: e.message + ' (VNC로 bid.tideflo.work 로그인 필요)' }); }

        const targetBids = allBids.filter(b => bidRowIds.includes(b.bidRowId));
        if (!targetBids.length) return json({ ok: false, error: `지정된 bidRowId를 assigned 목록에서 찾을 수 없음: ${bidRowIds.join(', ')}` });

        const tasks = targetBids.map(b => async () => {
          const t0 = Date.now();
          const d = await detailBid(b.bidRowId);
          const docs = [];
          for (const doc of d.documents) {
            try { docs.push({ name: doc.name, markdown: (await fetchDocMarkdown(doc.docId)).slice(0, cap) }); }
            catch (de) { docs.push({ name: doc.name, error: de.message }); }
          }
          const docText = docs.map(x => `## ${x.name}\n${x.markdown || '(no content: ' + x.error + ')'}`).join('\n\n---\n\n');
          const prompt = `다음 입찰공고를 **정확히 ${targetChars}자 이상** 분량으로 아래 구조에 맞춰 한국어로 상세 요약.

**반드시 지킬 것**:
- 총 분량 ${targetChars}자 이상 (미달 시 각 섹션 더 구체화해서 채워. 추상적 "~등 다수" 금지, 구체 명시)
- 각 불릿은 1~2문장 완결형 (단어 나열 금지)
- 문서에 있는 **구체 수치·날짜·기관명·조건** 최대한 포함
- 축약·생략·"..." 표기 금지

**구조**:
[사업명: ${d.title} / 공고번호: ${d.bidNo} / bidRowId: ${b.bidRowId}]

1. 발주기관 / 예산 / 마감일 / 계약기간 (구체 수치·일시)
2. 사업 개요 (${Math.floor(targetChars*0.15)}자 이상, 배경·목적·범위 포함)
3. 핵심 기술 요구사항 (불릿 ${bullets}, 각 불릿 50자 이상)
4. 평가 기준·배점표 (세부 평가항목·배점 명시)
5. 제출 서류 체크리스트 (누락 없이 전부 나열)
6. 우리 회사 적합도 분석 (${Math.floor(targetChars*0.12)}자 이상, 강점·약점·준비 필요 사항)
7. 리스크·질의사항 (${Math.floor(targetChars*0.12)}자 이상, 각 리스크 구체 시나리오)

**문서 내용**:
${docText}`;
          const summary = await callLLM(prompt, apiKey, maxTokens);
          return { bidRowId: b.bidRowId, bidNo: d.bidNo, title: d.title, preview: b.preview, summary, elapsedMs: Date.now() - t0 };
        });

        const results = await Promise.all(tasks.map(t => t().catch(e => ({ bidRowId: '?', error: e.message }))));
        return json({ ok: true, count: results.length, totalElapsedMs: Date.now() - started, bids: results });
      },
    });

    api.registerTool({
      name: 'bid_summarize_assigned',
      label: '배정된 입찰 종합 조회',
      description: '오늘/현재 배정된 모든 입찰공고를 한 번에 가져옴 (목록 → 상세 → 모든 문서 markdown). detail 파라미터로 문서당 크기 조절 (normal=20KB, detailed=35KB, deep=60KB). 비서가 이 결과만으로 각 사업별 세부사항까지 포함해 요약 작성 가능. 추가 bid_document_text 호출 불필요.',
      parameters: {
        type: 'object',
        properties: {
          detail: { type: 'string', enum: ['normal', 'detailed', 'deep'], description: '문서 크기: normal=20KB, detailed=35KB, deep=60KB (기본 normal)' },
        },
      },
      async execute(_, params) {
        const cap = params?.detail === 'deep' ? 60000 : params?.detail === 'detailed' ? 35000 : 20000;
        try {
          const bids = await listBids('assigned');
          const result = [];
          for (const b of bids) {
            try {
              const d = await detailBid(b.bidRowId);
              const docs = [];
              for (const doc of d.documents) {
                try {
                  const md = await fetchDocMarkdown(doc.docId);
                  docs.push({ docId: doc.docId, name: doc.name, markdown: md.slice(0, cap) });
                } catch (de) {
                  docs.push({ docId: doc.docId, name: doc.name, error: de.message });
                }
              }
              result.push({ bidRowId: b.bidRowId, bidNo: d.bidNo, title: d.title, preview: b.preview, documents: docs });
            } catch (be) {
              result.push({ bidRowId: b.bidRowId, preview: b.preview, error: be.message });
            }
          }
          return json({ ok: true, count: result.length, bids: result });
        } catch (e) { return json({ ok: false, error: e.message + ' (VNC로 bid.tideflo.work 로그인 필요)' }); }
      },
    });
  },
};

module.exports = bidPlugin;
module.exports.default = bidPlugin;
