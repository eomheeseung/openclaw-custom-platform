// @ts-nocheck
// G2B Plugin — 나라장터(조달청) 낙찰 이력 조회 via host automap-api

const http = require('http');

const API_HOST = '172.18.0.1';
const API_PORT = 18799;

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST, port: API_PORT, path, method,
      headers: { 'Content-Type': 'application/json' },
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
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('API timeout (120s)')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const json = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const g2bPlugin = {
  id: 'g2b',
  name: 'G2B (나라장터)',
  description: '조달청 나라장터 낙찰 이력 조회 — 발주기관·기간·사업명 키워드 기반.',

  configSchema: {
    parse(value) {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true };
    },
    uiHints: { enabled: { label: 'Enable G2B Tools' } },
  },

  register(api) {
    const config = api.pluginConfig;
    if (config?.enabled === false) return;

    console.log('[plugins] G2B tools registered: g2b_history');

    api.registerTool({
      name: 'g2b_history',
      label: '나라장터 낙찰 이력',
      description: `조달청 나라장터에서 발주기관(수요기관)의 과거 낙찰 이력을 조회합니다. 발주처가 과거에 어떤 사업을 누구한테 발주했는지, 낙찰가격은 얼마였는지 정확한 데이터를 가져옵니다. 제안서 검토 시 경쟁사 분석·시장 조사용으로 사용하세요. web_search 사용 금지 — 이 도구가 정확합니다.`,
      parameters: {
        type: 'object',
        required: ['agency'],
        properties: {
          agency: {
            type: 'string',
            description: '발주기관명(수요기관) 정확히. 예: "한국저작권위원회"',
          },
          businessType: {
            type: 'string',
            enum: ['물품', '공사', '용역', '외자'],
            description: '업무 분야 (기본: 용역)',
          },
          yearsBack: {
            type: 'number',
            description: '현재 연도 제외 N년 (기본 3 = 작년부터 3년치)',
          },
          fromDate: {
            type: 'string',
            description: 'YYYY-MM-DD (직접 지정 시 yearsBack 무시)',
          },
          toDate: {
            type: 'string',
            description: 'YYYY-MM-DD',
          },
          bidNtceNm: {
            type: 'string',
            description: '사업명 부분 일치 검색 (예: "공유마당", "DB 구축"). 같은 사업의 과거 연도판 찾을 때 활용.',
          },
          ntceInsttNm: {
            type: 'string',
            description: '공고기관명 (수요기관과 별개. 예: "조달청 경남지방조달청")',
          },
          indstrytyNm: {
            type: 'string',
            description: '업종명 (선택)',
          },
          pageSize: {
            type: 'number',
            description: '청크당 페이지 크기 (기본 100, 최대 999)',
          },
          maxPages: {
            type: 'number',
            description: '청크당 최대 페이지 (기본 20)',
          },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const result = await apiRequest('POST', '/api/g2b/history', params);
          if (!result.ok) return json({ error: result.error || 'G2B API 호출 실패', detail: result });

          // 결과 요약: 낙찰자별 집계 추가
          const items = result.items || [];
          const winners = {};
          for (const it of items) {
            const nm = it.winnerName || '(미정/유찰)';
            if (!winners[nm]) winners[nm] = { count: 0, totalAmt: 0 };
            winners[nm].count++;
            const amt = parseInt(it.winnerAmt || '0', 10);
            if (!isNaN(amt)) winners[nm].totalAmt += amt;
          }
          const topWinners = Object.entries(winners)
            .map(([name, v]) => ({ name, count: v.count, totalAmt: v.totalAmt }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

          return json({
            success: true,
            period: result.period,
            businessType: result.businessType,
            chunks: result.chunks,
            apiCalls: result.totalApiCalls,
            totalItems: items.length,
            stoppedReason: result.stoppedReason,
            topWinners,
            items,
          });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });
  },
};

module.exports = g2bPlugin;
module.exports.default = g2bPlugin;
