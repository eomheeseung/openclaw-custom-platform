// @ts-nocheck
// Local Files Plugin — relay tool calls to TideClaw Desktop Electron client via WebSocket

// --- Shared state ---
const pendingRequests = new Map();
let broadcastFn = null;
let timeoutMs = 15000;

function generateId() {
  return `lf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function requestFromClient(action, params) {
  if (!broadcastFn) {
    throw new Error(
      "데스크톱 클라이언트가 연결되지 않았습니다. TideClaw Desktop 앱을 실행해주세요.",
    );
  }

  const requestId = generateId();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(
        new Error(
          "데스크톱 클라이언트에서 응답이 없습니다. TideClaw Desktop 앱이 실행 중인지 확인해주세요.",
        ),
      );
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer });

    broadcastFn("localfile.request", {
      requestId,
      action,
      params,
    });
  });
}

const json = (payload) => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
});

// Plain JSON Schema objects (no external dependencies)
const PathSchema = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string", description: "파일 또는 폴더의 전체 경로" },
  },
};

const WriteSchema = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: { type: "string", description: "파일 경로" },
    content: { type: "string", description: "파일에 쓸 내용" },
  },
};

const EmptySchema = { type: "object", properties: {} };

// --- Plugin ---
const localFilesPlugin = {
  id: "local-files",
  name: "Local Files",
  description: "사용자 데스크톱 PC의 로컬 파일에 접근합니다.",

  configSchema: {
    parse(value) {
      const raw =
        value && typeof value === "object" && !Array.isArray(value) ? value : {};
      return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
        timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 15000,
      };
    },
    uiHints: {
      enabled: { label: "Enable Local File Tools" },
      timeoutMs: { label: "Request Timeout (ms)", advanced: true },
    },
  },

  register(api) {
    const config = api.pluginConfig;
    if (config?.enabled === false) return;
    if (config?.timeoutMs) timeoutMs = config.timeoutMs;

    // --- Gateway method: client sends responses here ---
    api.registerGatewayMethod("localfiles.response", async ({ params, respond, context }) => {
      if (!broadcastFn) broadcastFn = context.broadcast;

      const requestId = params?.requestId;
      const pending = requestId ? pendingRequests.get(requestId) : undefined;

      if (!pending) {
        respond(false, undefined, { type: "not_found", message: `No pending request: ${requestId}` });
        return;
      }

      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);

      if (params?.error) {
        pending.reject(new Error(params.error));
      } else {
        pending.resolve(params?.result);
      }

      respond(true, { ok: true });
    });

    // Capture broadcast from ping
    api.registerGatewayMethod("localfiles.ping", async ({ respond, context }) => {
      if (!broadcastFn) broadcastFn = context.broadcast;
      respond(true, { ok: true, desktop: !!broadcastFn });
    });

    // --- Tools ---
    api.registerTool({
      name: "local_file_read",
      label: "로컬 파일 읽기",
      description: "사용자의 데스크톱 PC에서 텍스트 파일을 읽습니다. PDF, 이미지 등 바이너리 파일은 local_file_read_binary를 사용하세요.",
      parameters: PathSchema,
      async execute(_toolCallId, params) {
        const result = await requestFromClient("file:read", { path: params.path });
        if (!result?.ok) return json({ error: result?.error || "파일 읽기 실패" });
        return json({ path: params.path, content: result.content });
      },
    });

    api.registerTool({
      name: "local_file_read_binary",
      label: "로컬 바이너리 파일 읽기",
      description: "사용자의 데스크톱 PC에서 바이너리 파일(PDF, 이미지, 엑셀 등)을 base64로 읽습니다.",
      parameters: PathSchema,
      async execute(_toolCallId, params) {
        const result = await requestFromClient("file:readBinary", { path: params.path });
        if (!result?.ok) return json({ error: result?.error || "바이너리 파일 읽기 실패" });
        return json({ path: params.path, content: result.content, size: result.size, encoding: "base64" });
      },
    });

    api.registerTool({
      name: "local_file_write",
      label: "로컬 파일 쓰기",
      description: "사용자의 데스크톱 PC에 파일을 작성합니다.",
      parameters: WriteSchema,
      async execute(_toolCallId, params) {
        const result = await requestFromClient("file:write", { path: params.path, content: params.content });
        if (!result?.ok) return json({ error: result?.error || "파일 쓰기 실패" });
        return json({ path: params.path, success: true });
      },
    });

    api.registerTool({
      name: "local_file_list",
      label: "로컬 폴더 목록",
      description: "사용자의 데스크톱 PC에서 폴더 내 파일/폴더 목록을 조회합니다.",
      parameters: PathSchema,
      async execute(_toolCallId, params) {
        const result = await requestFromClient("file:list", { path: params.path });
        if (!result?.ok) return json({ error: result?.error || "폴더 목록 조회 실패" });
        return json({ path: params.path, items: result.items });
      },
    });

    api.registerTool({
      name: "local_file_stat",
      label: "로컬 파일 정보",
      description: "사용자의 데스크톱 PC에서 파일/폴더의 크기, 수정일 등 메타데이터를 조회합니다.",
      parameters: PathSchema,
      async execute(_toolCallId, params) {
        const result = await requestFromClient("file:stat", { path: params.path });
        if (!result?.ok) return json({ error: result?.error || "파일 정보 조회 실패" });
        return json({ path: params.path, stat: result.stat });
      },
    });

    api.registerTool({
      name: "local_file_write_binary",
      label: "로컬 바이너리 파일 쓰기",
      description: "사용자의 데스크톱 PC에 바이너리 파일(PDF, 이미지 등)을 저장합니다. 서버의 파일을 먼저 읽어서(read tool 사용) base64로 변환 후 전송합니다.",
      parameters: {
        type: "object",
        required: ["path", "base64"],
        properties: {
          path: { type: "string", description: "저장할 파일 경로 (예: C:\\Users\\user\\Desktop\\report.pdf)" },
          base64: { type: "string", description: "base64로 인코딩된 파일 내용" },
        },
      },
      async execute(_toolCallId, params) {
        const result = await requestFromClient("file:writeBinary", { path: params.path, base64: params.base64 });
        if (!result?.ok) return json({ error: result?.error || "바이너리 파일 쓰기 실패" });
        return json({ path: params.path, success: true, size: result.size });
      },
    });

    // --- PDF Tools ---
    api.registerTool({
      name: "local_pdf_read",
      label: "로컬 PDF 읽기",
      description: "사용자의 데스크톱 PC에서 PDF 파일의 텍스트를 추출합니다. firstPage/lastPage로 특정 페이지만 읽을 수 있습니다.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "PDF 파일 경로" },
          firstPage: { type: "number", description: "시작 페이지 (1부터)" },
          lastPage: { type: "number", description: "끝 페이지" },
        },
      },
      async execute(_toolCallId, params) {
        const result = await requestFromClient("pdf:read", { path: params.path, firstPage: params.firstPage, lastPage: params.lastPage });
        if (!result?.ok) return json({ error: result?.error || "PDF 읽기 실패" });
        return json({ path: params.path, text: result.text, pages: result.pages, info: result.info });
      },
    });

    api.registerTool({
      name: "local_pdf_create",
      label: "로컬 PDF 생성",
      description: "HTML 내용으로 PDF를 생성하여 사용자 PC에 저장합니다. wkhtmltopdf 없이 Electron 내장 기능으로 직접 변환합니다.",
      parameters: {
        type: "object",
        required: ["path", "html"],
        properties: {
          path: { type: "string", description: "저장할 PDF 파일 경로" },
          html: { type: "string", description: "PDF로 변환할 HTML 내용" },
          landscape: { type: "boolean", description: "가로 모드 (기본: false)" },
          pageSize: { type: "string", description: "용지 크기 (기본: A4)" },
        },
      },
      async execute(_toolCallId, params) {
        const result = await requestFromClient("pdf:create", { path: params.path, html: params.html, landscape: params.landscape, pageSize: params.pageSize });
        if (!result?.ok) return json({ error: result?.error || "PDF 생성 실패" });
        return json({ path: params.path, success: true, size: result.size });
      },
    });

    // --- Excel Tools ---
    api.registerTool({
      name: "local_excel_read",
      label: "로컬 Excel 읽기",
      description: "사용자의 데스크톱 PC에서 Excel(.xlsx/.xls) 파일을 읽어 JSON으로 반환합니다. 특정 시트를 지정할 수 있습니다.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Excel 파일 경로" },
          sheet: { type: "string", description: "읽을 시트 이름 (생략 시 첫 번째 시트)" },
        },
      },
      async execute(_toolCallId, params) {
        const result = await requestFromClient("excel:read", { path: params.path, opts: { sheet: params.sheet } });
        if (!result?.ok) return json({ error: result?.error || "Excel 읽기 실패" });
        return json({ path: params.path, sheetNames: result.sheetNames, currentSheet: result.currentSheet, rows: result.rows, rowCount: result.rowCount });
      },
    });

    api.registerTool({
      name: "local_excel_write",
      label: "로컬 Excel 쓰기",
      description: "사용자의 데스크톱 PC에 새 Excel 파일을 생성합니다. rows는 JSON 배열로 전달합니다. 여러 시트를 만들 수도 있습니다.",
      parameters: {
        type: "object",
        required: ["path", "data"],
        properties: {
          path: { type: "string", description: "저장할 Excel 파일 경로 (.xlsx)" },
          data: {
            type: "object",
            description: "Excel 데이터. { rows: [{col1: val, col2: val}...], sheetName: '시트명' } 또는 여러 시트: { sheets: [{ name: '시트1', rows: [...] }, ...] }",
          },
        },
      },
      async execute(_toolCallId, params) {
        const result = await requestFromClient("excel:write", { path: params.path, data: params.data });
        if (!result?.ok) return json({ error: result?.error || "Excel 쓰기 실패" });
        return json({ path: params.path, success: true });
      },
    });

    api.registerTool({
      name: "local_excel_modify",
      label: "로컬 Excel 수정",
      description: "사용자의 데스크톱 PC에서 기존 Excel 파일의 특정 셀이나 행을 수정합니다.",
      parameters: {
        type: "object",
        required: ["path", "modifications"],
        properties: {
          path: { type: "string", description: "수정할 Excel 파일 경로" },
          modifications: {
            type: "object",
            description: "수정할 내용. { sheet: '시트명', cells: [{ cell: 'A1', value: '새값' }...], rows: [{ row: 0, data: { 열이름: 값 } }...] }",
          },
        },
      },
      async execute(_toolCallId, params) {
        const result = await requestFromClient("excel:modify", { path: params.path, modifications: params.modifications });
        if (!result?.ok) return json({ error: result?.error || "Excel 수정 실패" });
        return json({ path: params.path, success: true });
      },
    });

    api.registerTool({
      name: "local_homedir",
      label: "로컬 홈 디렉토리",
      description: "사용자 데스크톱 PC의 홈 디렉토리 경로를 반환합니다.",
      parameters: EmptySchema,
      async execute() {
        const result = await requestFromClient("system:homedir", {});
        return json({ homedir: result });
      },
    });

    api.logger.info("Local file tools registered");
  },
};

export default localFilesPlugin;
