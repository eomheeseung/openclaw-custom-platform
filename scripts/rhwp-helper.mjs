#!/usr/bin/env node
// rhwp-helper.mjs — stdin으로 JSON 요청 받아 @rhwp/core WASM으로 HWP 처리 후 stdout으로 JSON 반환
// 사용: echo '{"op":"parse","fileBase64":"..."}' | node rhwp-helper.mjs

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// measureTextWidth 폴리필 (SVG 렌더링용 글자 너비 근사)
globalThis.measureTextWidth = (font, text) => {
  // 한글: ~0.6em, ASCII: ~0.45em 근사
  const fontSize = parseFloat(font) || 16;
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    width += (code > 0x2E7F) ? fontSize * 0.6 : fontSize * 0.45;
  }
  return width;
};

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  input = input.trim();
  if (!input) { process.stdout.write(JSON.stringify({ ok: false, error: 'no input' })); return; }

  let req;
  try { req = JSON.parse(input); } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid JSON: ' + e.message }));
    return;
  }

  const { op, fileBase64, page } = req;

  try {
    // WASM 초기화
    const wasmPath = resolve(__dirname, 'node_modules/@rhwp/core/rhwp_bg.wasm');
    const wasmBuf = readFileSync(wasmPath);
    const { default: init, HwpDocument } = await import('/opt/openclaw/scripts/node_modules/@rhwp/core/rhwp.js');
    await init({ module_or_path: new WebAssembly.Module(wasmBuf) });

    // 파일 로드
    const fileBytes = Buffer.from(fileBase64, 'base64');
    const doc = new HwpDocument(new Uint8Array(fileBytes));

    if (op === 'parse') {
      const total = doc.pageCount();
      const parts = [];
      for (let i = 0; i < total; i++) {
        try {
          const layout = doc.getPageTextLayout(i);
          const parsed = JSON.parse(layout);
          // 텍스트 노드 재귀 추출
          parts.push(extractText(parsed));
        } catch { /* 일부 페이지 실패 시 skip */ }
      }
      process.stdout.write(JSON.stringify({ ok: true, text: parts.join('\n'), pageCount: total }));

    } else if (op === 'info') {
      const info = JSON.parse(doc.getDocumentInfo());
      const total = doc.pageCount();
      process.stdout.write(JSON.stringify({ ok: true, info: { ...info, pageCount: total } }));

    } else if (op === 'export-svg') {
      const pageNum = typeof page === 'number' ? page : 0;
      const total = doc.pageCount();
      if (pageNum < 0 || pageNum >= total) {
        process.stdout.write(JSON.stringify({ ok: false, error: `페이지 범위 초과 (0~${total - 1})` }));
        return;
      }
      const svg = doc.renderPageSvg(pageNum);
      process.stdout.write(JSON.stringify({ ok: true, svg, pageCount: total }));

    } else if (op === 'export-svg-all') {
      const total = doc.pageCount();
      const pages = [];
      for (let i = 0; i < total; i++) {
        try { pages.push(doc.renderPageSvg(i)); } catch { pages.push(''); }
      }
      process.stdout.write(JSON.stringify({ ok: true, pages, pageCount: total }));

    } else {
      process.stdout.write(JSON.stringify({ ok: false, error: 'unknown op: ' + op }));
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err.message ?? err) }));
  }
}

function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node.text) return node.text;
  if (node.children) return extractText(node.children);
  if (node.paragraphs) return extractText(node.paragraphs);
  if (node.lines) return extractText(node.lines);
  if (node.spans) return extractText(node.spans);
  if (node.chars) return extractText(node.chars);
  if (node.value) return typeof node.value === 'string' ? node.value : '';
  // 객체의 모든 배열/문자열 값 재귀
  return Object.values(node).map(v => (typeof v === 'object' || Array.isArray(v)) ? extractText(v) : '').join('');
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
});
