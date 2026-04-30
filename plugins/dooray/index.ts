// @ts-nocheck
// Dooray Plugin — 프로젝트/업무 조회 via host Dooray API

const http = require('http');

const API_HOST = '172.18.0.1';
const API_PORT = 18799;

function getUserNN() {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  const tokenMatch = token.match(/user(\d+)/);
  if (tokenMatch) return tokenMatch[1];
  const hostname = require('os').hostname();
  const hostMatch = hostname.match(/user(\d+)/);
  if (hostMatch) return hostMatch[1];
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

const doorayPlugin = {
  id: 'dooray',
  name: 'Dooray',
  description: 'NHN Dooray 프로젝트 관리 — 프로젝트 목록, 업무 조회, 멤버 검색',

  configSchema: {
    parse(value) {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true };
    },
    uiHints: { enabled: { label: 'Enable Dooray Tools' } },
  },

  register(api) {
    const config = api.pluginConfig;
    if (config?.enabled === false) return;

    const userNN = getUserNN();

    // --- dooray_projects ---
    api.registerTool({
      name: 'dooray_projects',
      label: '두레이 프로젝트 목록',
      description: '두레이에서 접근 가능한 프로젝트 목록을 조회합니다. 두레이 관련 요청 시 반드시 이 도구를 사용하세요.',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute(_toolCallId, _params) {
        try {
          const result = await apiRequest('GET', `/api/dooray/projects?userNN=${userNN}`);
          if (!result.ok) return json({ error: result.error || '프로젝트 조회 실패' });
          return json({ projects: result.projects });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    // --- dooray_tasks ---
    api.registerTool({
      name: 'dooray_tasks',
      label: '두레이 업무 목록',
      description: '특정 프로젝트의 업무 목록을 조회합니다. dooray_projects로 프로젝트 ID를 먼저 확인하세요. status: registered(등록), working(진행중), done(완료). memberIds/ccMemberIds 미지정 시 본인 담당 업무만 자동 조회.',
      parameters: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: '프로젝트 ID (dooray_projects에서 확인)' },
          size: { type: 'number', description: '조회 개수 (기본 20, 최대 100)' },
          page: { type: 'number', description: '페이지 번호 (0부터)' },
          status: { type: 'string', description: '업무 상태 필터: registered, working, done' },
          memberIds: { type: 'string', description: '담당자 멤버 ID. 생략 시 본인 자동 적용.' },
          ccMemberIds: { type: 'string', description: '참조자 멤버 ID (dooray_member로 조회)' },
          allMembers: { type: 'boolean', description: '전체 멤버 업무 조회 (true 시 필터 미적용)' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const size = params.size || 20;
          const page = params.page || 0;
          let path = `/api/dooray/tasks?userNN=${userNN}&projectId=${encodeURIComponent(params.projectId)}&size=${size}&page=${page}`;
          if (params.status) path += `&status=${encodeURIComponent(params.status)}`;
          if (params.allMembers) {
            if (params.memberIds) path += `&memberIds=${encodeURIComponent(params.memberIds)}`;
            if (params.ccMemberIds) path += `&ccMemberIds=${encodeURIComponent(params.ccMemberIds)}`;
          } else {
            if (params.memberIds) {
              path += `&memberIds=${encodeURIComponent(params.memberIds)}`;
            } else {
              try {
                const intResult = await apiRequest('GET', `/api/integrations/load?userNN=${userNN}`);
                const ownMemberId = intResult?.data?.dooray?.memberId;
                if (ownMemberId) path += `&memberIds=${encodeURIComponent(ownMemberId)}`;
              } catch {}
            }
            if (params.ccMemberIds) path += `&ccMemberIds=${encodeURIComponent(params.ccMemberIds)}`;
          }
          const result = await apiRequest('GET', path);
          if (!result.ok) return json({ error: result.error || '업무 조회 실패' });
          return json({ tasks: result.tasks, totalCount: result.totalCount, page: result.page, size: result.size });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    // --- dooray_task ---
    api.registerTool({
      name: 'dooray_task',
      label: '두레이 업무 상세',
      description: '특정 업무의 상세 내용(본문, 담당자, 참조자, 태그, 마일스톤 등)을 조회합니다.',
      parameters: {
        type: 'object',
        required: ['projectId', 'taskId'],
        properties: {
          projectId: { type: 'string', description: '프로젝트 ID' },
          taskId: { type: 'string', description: '업무 ID' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const result = await apiRequest('GET',
            `/api/dooray/task?userNN=${userNN}&projectId=${encodeURIComponent(params.projectId)}&taskId=${encodeURIComponent(params.taskId)}`);
          if (!result.ok) return json({ error: result.error || '업무 상세 조회 실패' });
          return json({ task: result.task });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    // --- dooray_member ---
    api.registerTool({
      name: 'dooray_member',
      label: '두레이 멤버 조회',
      description: '이름 또는 이메일로 두레이 멤버를 검색합니다. 멤버 ID는 업무 필터(memberIds, ccMemberIds)에 사용합니다.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: '멤버 이름 또는 이메일 주소' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const q = params.query.trim();
          const paramKey = q.includes('@') ? 'email' : 'name';
          const result = await apiRequest('GET',
            `/api/dooray/member?userNN=${userNN}&${paramKey}=${encodeURIComponent(q)}`);
          if (!result.ok) return json({ error: result.error || '멤버 조회 실패' });
          return json({ members: result.members });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    api.logger.info(`Dooray tools registered for user${userNN}`);
  },
};

export default doorayPlugin;
