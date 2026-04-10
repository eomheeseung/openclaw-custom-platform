// @ts-nocheck
// File Share Plugin — 파일 생성 후 다운로드 링크 제공

const http = require('http');
const fs = require('fs');
const path = require('path');

const API_HOST = '172.18.0.1';
const API_PORT = 18799;
const DOWNLOAD_BASE = 'http://claw.tideflo.work/api/file/download';
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

const json = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const fileSharePlugin = {
  id: 'file-share',
  name: 'File Share',
  description: '파일을 생성하고 사용자가 다운로드할 수 있는 링크를 제공합니다.',

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

    // --- file_create_and_share ---
    api.registerTool({
      name: 'file_create_and_share',
      label: '파일 생성 및 다운로드 링크',
      description: '파일을 생성하고 사용자가 다운로드할 수 있는 링크를 반환합니다. 사용자에게 파일을 전달할 때 반드시 이 도구를 사용하세요. write 도구로 파일을 만든 후에도 이 도구로 다운로드 링크를 생성하세요.',
      parameters: {
        type: 'object',
        required: ['filename', 'content'],
        properties: {
          filename: { type: 'string', description: '파일명 (예: 보고서.md, 결과.csv, 분석.html)' },
          content: { type: 'string', description: '파일 내용' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const filename = params.filename.replace(/[\/\\]/g, '_');
          const filePath = path.join(DOCUMENTS_DIR, filename);
          fs.writeFileSync(filePath, params.content, 'utf-8');
          const downloadUrl = `${DOWNLOAD_BASE}?userNN=${userNN}&path=${encodeURIComponent(filename)}`;
          return json({
            success: true,
            filename,
            path: filePath,
            downloadUrl,
            message: `파일이 생성되었습니다. 아래 링크로 다운로드하세요.`,
          });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    // --- file_get_download_link ---
    api.registerTool({
      name: 'file_get_download_link',
      label: '파일 다운로드 링크 생성',
      description: '이미 존재하는 파일의 다운로드 링크를 생성합니다. /home/node/documents/ 안의 파일만 가능합니다.',
      parameters: {
        type: 'object',
        required: ['filename'],
        properties: {
          filename: { type: 'string', description: '파일명 (documents 폴더 기준)' },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const filename = params.filename.replace(/^\/home\/node\/documents\//, '').replace(/[\/\\]/g, '_');
          const filePath = path.join(DOCUMENTS_DIR, filename);
          if (!fs.existsSync(filePath)) {
            return json({ error: `파일을 찾을 수 없습니다: ${filename}` });
          }
          const stat = fs.statSync(filePath);
          const downloadUrl = `${DOWNLOAD_BASE}?userNN=${userNN}&path=${encodeURIComponent(filename)}`;
          return json({
            success: true,
            filename,
            size: stat.size,
            downloadUrl,
          });
        } catch (err) {
          return json({ error: err.message });
        }
      },
    });

    api.logger.info(`File Share tools registered for user${userNN}`);
  },
};

export default fileSharePlugin;
