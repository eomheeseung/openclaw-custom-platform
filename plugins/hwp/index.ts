// @ts-nocheck
// HWP Plugin — rhwp(WASM) 기반 HWP/HWPX 파일 읽기/변환/정보 조회

const http = require('http');
const fs = require('fs');
const path = require('path');

const API_HOST = '172.18.0.1';
const API_PORT = 18799;
const DOCUMENTS_DIR = '/home/node/documents';

function getUserNN() {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  const tokenMatch = token.match(/user(\d+)/);
  if (tokenMatch) return tokenMatch[1];
  const hostname = require('os').hostname();
  const hostMatch = hostname.match(/user(\d+)/);
  if (hostMatch) return hostMatch[1];
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
    const gwToken = cfg?.gateway?.auth?.token || '';
    const cfgMatch = gwToken.match(/user(\d+)/);
    if (cfgMatch) return cfgMatch[1];
  } catch {}
  return '01';
}

function apiRequest(method, path_, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: path_,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('API timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

function resolveFilePath(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(DOCUMENTS_DIR, filePath);
}

function fileToBase64(filePath) {
  const resolved = resolveFilePath(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`파일을 찾을 수 없습니다: ${resolved}`);
  return fs.readFileSync(resolved).toString('base64');
}

const json = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const hwpPlugin = {
  id: 'hwp',
  name: 'HWP',
  description: 'HWP/HWPX 파일 읽기, 정보 조회, SVG 변환, 구글 드라이브 HWP 파싱',

  configSchema: {
    parse(value) {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true };
    },
  },

  register(api) {
    const config = api.pluginConfig;
    if (config?.enabled === false) return;

    const userNN = getUserNN();

    // --- hwp_read ---
    api.registerTool({
      name: 'hwp_read',
      label: 'HWP 파일 내용 읽기',
      description: 'HWP 또는 HWPX 파일의 텍스트 내용을 추출합니다. 사용자가 HWP 파일을 업로드하거나 경로를 알려주면 이 도구로 내용을 읽으세요.',
      parameters: {
        type: 'object',
        required: ['filePath'],
        properties: {
          filePath: { type: 'string', description: '파일 경로 (예: /home/node/documents/문서.hwp 또는 문서.hwp)' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const fileBase64 = fileToBase64(params.filePath);
          const fileName = path.basename(params.filePath);
          const result = await apiRequest('POST', '/api/hwp/parse', { userNN, fileBase64, fileName });
          if (!result.ok) return json({ error: result.error || 'HWP 읽기 실패' });
          return json({ text: result.text, pageCount: result.pageCount, fileName });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    // --- hwp_info ---
    api.registerTool({
      name: 'hwp_info',
      label: 'HWP 문서 정보',
      description: 'HWP/HWPX 파일의 메타데이터(페이지 수, 버전, 사용 글꼴 등)를 조회합니다.',
      parameters: {
        type: 'object',
        required: ['filePath'],
        properties: {
          filePath: { type: 'string', description: '파일 경로' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const fileBase64 = fileToBase64(params.filePath);
          const result = await apiRequest('POST', '/api/hwp/info', { userNN, fileBase64 });
          if (!result.ok) return json({ error: result.error || '정보 조회 실패' });
          return json({ info: result.info });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    // --- hwp_export_page ---
    api.registerTool({
      name: 'hwp_export_page',
      label: 'HWP 페이지 SVG 변환',
      description: 'HWP/HWPX 파일의 특정 페이지를 SVG 이미지로 변환하고 다운로드 링크를 제공합니다. 페이지 번호는 1부터 시작합니다.',
      parameters: {
        type: 'object',
        required: ['filePath'],
        properties: {
          filePath: { type: 'string', description: '파일 경로' },
          page: { type: 'number', description: '페이지 번호 (1부터 시작, 기본값: 1)' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const fileBase64 = fileToBase64(params.filePath);
          const fileName = path.basename(params.filePath);
          const pageNum = (params.page || 1) - 1; // 0-indexed
          const result = await apiRequest('POST', '/api/hwp/export-svg', { userNN, fileBase64, page: pageNum, fileName });
          if (!result.ok) return json({ error: result.error || 'SVG 변환 실패' });
          return json({
            downloadUrl: result.downloadUrl,
            svgPath: result.svgPath,
            page: pageNum + 1,
            totalPages: result.pageCount,
            message: `${pageNum + 1}페이지 SVG 변환 완료. 다운로드: ${result.downloadUrl}`,
          });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    // --- hwp_from_drive ---
    api.registerTool({
      name: 'hwp_from_drive',
      label: '구글 드라이브 HWP 읽기',
      description: '구글 드라이브의 HWP/HWPX 파일을 직접 읽어 텍스트를 추출합니다. drive_list나 drive_search로 fileId를 먼저 확인하세요.',
      parameters: {
        type: 'object',
        required: ['fileId'],
        properties: {
          fileId: { type: 'string', description: '구글 드라이브 파일 ID' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          // drive/read 엔드포인트를 통해 HWP 파일 읽기 (이미 rhwp로 교체됨)
          const result = await apiRequest('GET', `/api/drive/read?userNN=${userNN}&fileId=${encodeURIComponent(params.fileId)}`);
          if (!result.ok) return json({ error: result.error || '드라이브 HWP 읽기 실패' });
          return json({ text: result.content, fileName: result.name });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    api.logger.info(`HWP tools registered for user${userNN}`);
  },
};

export default hwpPlugin;
