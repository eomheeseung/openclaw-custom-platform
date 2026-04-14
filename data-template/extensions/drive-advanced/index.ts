// @ts-nocheck
// Drive Advanced Search Plugin — 날짜·수정자·키워드 등 복합 조건 Drive 검색

const http = require('http');

const API_HOST = '172.18.0.1';
const API_PORT = 18799;

function getUserNN() {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  const m = token.match(/user(\d+)/);
  if (m) return m[1];
  const hostname = require('os').hostname();
  const hm = hostname.match(/user(\d+)/);
  if (hm) return hm[1];
  try {
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
    const gw = cfg?.gateway?.auth?.token || '';
    const cm = gw.match(/user(\d+)/);
    if (cm) return cm[1];
  } catch {}
  return '01';
}

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST, port: API_PORT, path, method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
      const s = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(s);
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('API timeout (60s)')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const json = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const drivePlugin = {
  id: 'drive-advanced',
  name: 'Drive Advanced Search',
  description: 'Google Drive에서 날짜·수정자·키워드 등 복합 조건으로 파일 검색.',

  configSchema: {
    parse(value) {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true };
    },
    uiHints: { enabled: { label: 'Enable Drive Advanced Search' } },
  },

  register(api) {
    const config = api.pluginConfig;
    if (config?.enabled === false) return;

    const userNN = getUserNN();
    console.log('[plugins] Drive Advanced tools registered: drive_search');

    api.registerTool({
      name: 'drive_search',
      label: 'Drive 고급 검색',
      description: `Google Drive에서 날짜 범위·수정자·파일명·본문 키워드·파일 종류 등 복합 조건으로 검색합니다. 단순 키워드 1개 검색은 gog drive search로 충분하지만, 다음 중 하나라도 있으면 반드시 이 도구를 사용하세요: (1) 특정 기간 내 수정된 파일, (2) 특정 수정자 필터, (3) 여러 조건 조합, (4) 특정 공유 드라이브 한정. web_search는 사내 Drive 검색에 쓸 수 없으니 절대 사용하지 마세요.`,
      parameters: {
        type: 'object',
        properties: {
          modifiedAfter: {
            type: 'string',
            description: 'YYYY-MM-DD. 이 날짜 이후 수정된 파일만',
          },
          modifiedBefore: {
            type: 'string',
            description: 'YYYY-MM-DD. 이 날짜 이전 수정된 파일만',
          },
          modifiedByName: {
            type: 'string',
            description: '수정자 표시 이름 (예: "차명건")',
          },
          modifiedByEmail: {
            type: 'string',
            description: '수정자 이메일 (예: "blueyooe@tideflo.com")',
          },
          nameContains: {
            type: 'string',
            description: '파일명 부분 일치 키워드',
          },
          fullTextContains: {
            type: 'string',
            description: '본문 내용 부분 일치 키워드',
          },
          mimeType: {
            type: 'string',
            description: 'MIME 타입. 예: "application/pdf", "application/vnd.google-apps.spreadsheet"',
          },
          driveId: {
            type: 'string',
            description: '특정 공유 드라이브 ID 한정 (없으면 접근 가능한 모든 드라이브)',
          },
          includeFolders: {
            type: 'boolean',
            description: '폴더 포함 여부 (기본 false)',
          },
          pageSize: {
            type: 'number',
            description: '페이지 크기 (기본 100, 최대 1000)',
          },
          maxPages: {
            type: 'number',
            description: '최대 페이지 수 (기본 10, 최대 50). 결과 많을 때 안전장치',
          },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const result = await apiRequest('POST', '/api/drive/advanced-search', { userNN, ...params });
          if (!result.ok) return json({ error: result.error || 'Drive search 실패', detail: result });
          return json({
            success: true,
            account: result.account,
            query: result.query,
            corpora: result.corpora,
            totalFetched: result.totalFetched,
            matched: result.matched,
            stoppedReason: result.stoppedReason,
            files: result.files,
          });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });
  },
};

module.exports = drivePlugin;
module.exports.default = drivePlugin;
