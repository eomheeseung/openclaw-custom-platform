// @ts-nocheck
// RAG Plugin — search company knowledge base (Google Drive documents)

const http = require('http');

const RAG_HOST = '172.18.0.1';
const RAG_PORT = 18800;

function ragRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: RAG_HOST,
      port: RAG_PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    };
    if (body) {
      const bodyStr = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('RAG 서버 응답 시간 초과')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const json = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const ragPlugin = {
  id: 'rag',
  name: 'RAG Knowledge Base',
  description: '회사 Google Drive 문서에서 관련 정보를 검색합니다.',

  configSchema: {
    parse(value) {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true };
    },
    uiHints: { enabled: { label: 'Enable RAG Search' } },
  },

  register(api) {
    const config = api.pluginConfig;
    if (config?.enabled === false) return;

    api.registerTool({
      name: 'rag_search',
      label: '지식 검색',
      description: `회사 Google Drive의 공유 문서에서 관련 정보를 검색합니다.
회사 정책, 프로젝트 문서, 회의록, 가이드라인, 계약서 등을 찾을 때 사용하세요.
키워드와 자연어 질문 모두 지원합니다.`,
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: '검색 질문 또는 키워드' },
          limit: { type: 'number', description: '결과 수 (기본 8, 최대 20)' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const result = await ragRequest('POST', '/rag/search', {
            query: params.query,
            limit: Math.min(params.limit || 8, 20),
          });
          if (!result.ok) return json({ error: result.error || '검색 실패' });
          return json({
            count: result.results.length,
            results: result.results,
          });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    api.registerTool({
      name: 'rag_status',
      label: 'RAG 상태',
      description: 'RAG 지식 베이스의 현재 상태를 확인합니다 (인덱싱된 문서 수, 마지막 동기화 시간 등).',
      parameters: { type: 'object', properties: {} },
      async execute() {
        try {
          const result = await ragRequest('GET', '/rag/status');
          return json(result);
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    api.logger.info('RAG tools registered: rag_search, rag_status');
  },
};

export default ragPlugin;
