// @ts-nocheck
// Gmail Plugin — send/search/read email via host Mail API (tideflo.com)

const http = require('http');

const API_HOST = '172.18.0.1';
const API_PORT = 18799;

// Detect userNN from gateway token (e.g. "tc-user02" -> "02")
function getUserNN() {
  // 1) OPENCLAW_GATEWAY_TOKEN env (tc-user02 -> 02)
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  const tokenMatch = token.match(/user(\d+)/);
  if (tokenMatch) return tokenMatch[1];
  // 2) hostname fallback
  const hostname = require('os').hostname();
  const hostMatch = hostname.match(/user(\d+)/);
  if (hostMatch) return hostMatch[1];
  // 3) config fallback
  try {
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
    const gwToken = cfg?.gateway?.auth?.token || '';
    const cfgMatch = gwToken.match(/user(\d+)/);
    if (cfgMatch) return cfgMatch[1];
  } catch {}
  return '01';
}

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path,
      method,
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('API timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const json = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

// 이번 주 월~금 계산 (KST 기준)
function getWeekRange() {
  const now = new Date(Date.now() + 9 * 3600000); // UTC+9
  const day = now.getUTCDay(); // 0=일 1=월 ... 6=토
  const diffMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setUTCDate(mon.getUTCDate() + diffMon);
  const fri = new Date(mon);
  fri.setUTCDate(fri.getUTCDate() + 4);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { monday: fmt(mon), friday: fmt(fri), today: fmt(now) };
}

const gmailPlugin = {
  id: 'gmail',
  name: 'Gmail',
  description: 'tideflo.com 계정으로 이메일을 보내고, 검색하고, 읽습니다.',

  configSchema: {
    parse(value) {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true };
    },
    uiHints: { enabled: { label: 'Enable Gmail Tools' } },
  },

  register(api) {
    const config = api.pluginConfig;
    if (config?.enabled === false) return;

    const userNN = getUserNN();

    // --- mail_send ---
    api.registerTool({
      name: 'mail_send',
      label: '메일 발송',
      description: `tideflo.com 회사 계정으로 이메일을 발송합니다. 반드시 이 도구를 사용하여 메일을 보내세요.`,
      parameters: {
        type: 'object',
        required: ['to', 'subject', 'body'],
        properties: {
          to: { type: 'string', description: '수신자 이메일 (쉼표로 여러 명 가능)' },
          cc: { type: 'string', description: '참조 (선택)' },
          subject: { type: 'string', description: '메일 제목' },
          body: { type: 'string', description: '메일 본문 (텍스트)' },
          bodyHtml: { type: 'string', description: '메일 본문 (HTML, 선택)' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const result = await apiRequest('POST', '/api/mail/send', {
            userNN, to: params.to, cc: params.cc,
            subject: params.subject, body: params.body, bodyHtml: params.bodyHtml,
          });
          if (!result.ok) return json({ error: result.error || '발송 실패' });
          const week = getWeekRange();
          return json({ success: true, from: result.from, messageId: result.messageId, weekRange: `${week.monday}~${week.friday}`, today: week.today });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    // --- mail_search ---
    api.registerTool({
      name: 'mail_search',
      label: '메일 검색',
      description: `tideflo.com 계정의 Gmail에서 메일을 검색합니다. Gmail 검색 문법 사용 가능 (from:, to:, subject:, is:unread 등). 반드시 이 도구를 사용하여 메일을 조회하세요.`,
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Gmail 검색어 (예: "from:someone@example.com", "is:unread", "subject:회의")' },
          max: { type: 'number', description: '최대 결과 수 (기본 10)' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const max = params.max || 10;
          const result = await apiRequest('GET',
            `/api/mail/search?userNN=${userNN}&q=${encodeURIComponent(params.query)}&max=${max}`,
          );
          if (!result.ok) return json({ error: result.error || '검색 실패' });
          const week = getWeekRange();
          return json({
            account: result.account, count: result.messages.length,
            messages: result.messages, nextPageToken: result.nextPageToken,
            weekRange: `${week.monday}~${week.friday}`, today: week.today,
          });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    // --- mail_read ---
    api.registerTool({
      name: 'mail_read',
      label: '메일 읽기',
      description: `특정 메일의 전체 내용을 읽습니다. mail_search로 얻은 메일 ID를 사용하세요.`,
      parameters: {
        type: 'object',
        required: ['messageId'],
        properties: {
          messageId: { type: 'string', description: 'mail_search에서 받은 메일 ID' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const result = await apiRequest('GET',
            `/api/mail/read?userNN=${userNN}&id=${encodeURIComponent(params.messageId)}`,
          );
          if (!result.ok) return json({ error: result.error || '읽기 실패' });
          return json({
            account: result.account, from: result.from, to: result.to,
            cc: result.cc, subject: result.subject, date: result.date,
            body: result.body, labels: result.labels,
          });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    api.logger.info(`Gmail tools registered for user${userNN}`);
  },
};

export default gmailPlugin;
