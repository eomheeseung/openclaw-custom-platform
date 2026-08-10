import { useState, useRef } from 'react';
import { X, Upload, CheckCircle2, AlertCircle, Building2, Key, Check } from 'lucide-react';

interface Props {
  userNN: string;
  onClose: () => void;
  onCreated: () => void;
}

type Step = 1 | 2 | 3;

interface TestResult {
  ok: boolean;
  http_status: number;
  detail: string;
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(bin);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40);
}

export function NewBusinessModal({ userNN, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [vendor, setVendor] = useState('(주)타이드플로');

  const [templateFile, setTemplateFile] = useState<{ name: string; size: number; base64: string } | null>(null);
  const [templatePreview, setTemplatePreview] = useState<{ detected: boolean; preview?: string | null; replacement?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [srBaseUrl, setSrBaseUrl] = useState('https://sr.tideflo.work');
  const [srTenant, setSrTenant] = useState('');
  const [srApiToken, setSrApiToken] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const onPickFile = () => fileRef.current?.click();
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.hwpx')) {
      setError('.hwpx 파일만 업로드 가능합니다.');
      return;
    }
    if (f.size > 20 * 1024 * 1024) {
      setError('파일이 너무 큽니다 (20MB 이하).');
      return;
    }
    const buf = await f.arrayBuffer();
    setTemplateFile({ name: f.name, size: f.size, base64: bufToBase64(buf) });
    setError('');
    /* 파일명 규칙 미리보기 */
    try {
      const r = await fetch('/api/business-report/preview-filename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: f.name }),
      });
      const d = await r.json();
      if (d.ok) setTemplatePreview({ detected: !!d.detected, preview: d.preview, replacement: d.replacement });
    } catch { /* ignore */ }
  };

  const canNext1 = id.trim() && name.trim() && org.trim() && templateFile;
  const canNext2 = srBaseUrl.trim() && srTenant.trim() && srApiToken.trim();

  const suggestIdFromName = () => {
    if (!id && name) setId(slugify(name));
  };

  const createProject = async (): Promise<string | null> => {
    const r = await fetch(`/api/business-report/projects?userNN=${userNN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: id.trim(),
        name: name.trim(),
        org: org.trim(),
        subtitle: subtitle.trim(),
        vendor: vendor.trim(),
        template_base64: templateFile?.base64,
        template_filename: templateFile?.name,
        userNN,
      }),
    });
    const d = await r.json();
    if (!d.ok) { setError(d.error || '등록 실패'); return null; }
    return d.project.id;
  };

  const saveAuth = async (pid: string): Promise<boolean> => {
    const r = await fetch(`/api/business-report/projects/${encodeURIComponent(pid)}/auth?userNN=${userNN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        SR_BASE_URL: srBaseUrl.trim(),
        SR_TENANT: srTenant.trim(),
        SR_API_TOKEN: srApiToken.trim(),
        userNN,
      }),
    });
    const d = await r.json();
    if (!d.ok) { setError(d.error || '인증 저장 실패'); return false; }
    return true;
  };

  const testConnection = async () => {
    setTesting(true);
    setError('');
    try {
      // 임시 프로젝트가 없어도 테스트만 하려면 미리 저장 필요.
      // 단순화: 실제 저장 후 test 호출 대신 사용자에게 저장 뒤 확인 안내.
      // 여기서는 API 형식만 미리 검증.
      if (!srBaseUrl.startsWith('http')) { setError('URL은 http(s)://로 시작해야 합니다.'); return; }
      if (!srApiToken.startsWith('srt_')) { setError('토큰은 srt_로 시작해야 합니다.'); return; }
      setTestResult({ ok: true, http_status: 0, detail: '형식 검증 통과 (실제 연결은 등록 완료 후 [연결 테스트]에서 확인 가능)' });
    } finally {
      setTesting(false);
    }
  };

  const finish = async () => {
    setSaving(true);
    setError('');
    try {
      const pid = await createProject();
      if (!pid) return;
      const ok = await saveAuth(pid);
      if (!ok) return;
      onCreated();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-card border border-border-color rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-color">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-accent" />
          </div>
          <div className="flex-1">
            <div className="font-bold text-sm text-text-primary">새 사업 추가{step > 1 && id ? ` · ${id}` : ''}</div>
            <div className="text-xs text-text-secondary">
              {step === 1 && '사업 정보와 주간보고 양식(.hwpx)을 등록합니다.'}
              {step === 2 && 'SR 시스템 접근 인증을 등록합니다.'}
              {step === 3 && '입력한 내용을 확인하고 등록을 완료합니다.'}
            </div>
          </div>
          <button className="p-1.5 hover:bg-background rounded-lg text-text-secondary" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex px-5 pt-4">
          {[
            { n: 1, label: '기본 정보' },
            { n: 2, label: 'SR 인증' },
            { n: 3, label: '확인' },
          ].map((s, i, arr) => (
            <div
              key={s.n}
              className={`flex-1 text-center text-xs font-semibold py-2 relative ${
                step === s.n
                  ? 'text-accent bg-accent/5 rounded-lg'
                  : step > s.n
                  ? 'text-emerald-500'
                  : 'text-text-secondary'
              }`}
            >
              {step > s.n ? '✓ ' : `${s.n}. `}
              {s.label}
              {i < arr.length - 1 && <span className="absolute right-[-6px] top-1/2 -translate-y-1/2 text-border-color">›</span>}
            </div>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {error && (
            <div className="flex gap-2 items-start p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-500">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>{error}</div>
            </div>
          )}

          {step === 1 && (
            <>
              <div>
                <label className="text-xs font-semibold text-text-primary block mb-1">
                  사업 ID <span className="text-red-500">*</span>
                </label>
                <input
                  value={id}
                  onChange={(e) => setId(slugify(e.target.value))}
                  onFocus={suggestIdFromName}
                  placeholder="knps-2026"
                  className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                />
                <div className="text-xs text-text-secondary mt-1">영문 소문자·숫자·하이픈. 파일 저장 경로에 쓰임.</div>
              </div>

              <div>
                <label className="text-xs font-semibold text-text-primary block mb-1">
                  사업명 <span className="text-red-500">*</span>
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="2026년 국립공원공단 홈페이지 유지관리"
                  className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-text-primary block mb-1">
                    발주기관 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={org}
                    onChange={(e) => setOrg(e.target.value)}
                    placeholder="국립공원공단"
                    className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-text-primary block mb-1">수행 업체</label>
                  <input
                    value={vendor}
                    onChange={(e) => setVendor(e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-text-primary block mb-1">부제 (선택)</label>
                <input
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  placeholder="예: 홈페이지 운영 및 기능개선 유지관리"
                  className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-text-primary block mb-1">
                  주간보고 양식 (.hwpx) <span className="text-red-500">*</span>
                </label>
                <input ref={fileRef} type="file" accept=".hwpx" className="hidden" onChange={onFileChange} />
                {templateFile ? (
                  <>
                    <div className="flex gap-3 items-center p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/40">
                      <div className="w-9 h-9 bg-card border border-emerald-500/40 rounded-lg flex items-center justify-center">
                        <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-emerald-500 truncate">{templateFile.name}</div>
                        <div className="text-xs text-emerald-500/80">{(templateFile.size / 1024).toFixed(1)} KB · 업로드됨</div>
                      </div>
                      <button className="px-2.5 py-1 text-xs border border-emerald-500/40 rounded-lg text-emerald-500 hover:bg-emerald-500/10" onClick={onPickFile}>
                        교체
                      </button>
                    </div>
                    {templatePreview && (
                      <div className={`mt-2 p-3 rounded-lg text-xs ${templatePreview.detected ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-amber-500/10 border border-amber-500/30'}`}>
                        {templatePreview.detected ? (
                          <>
                            <div className="font-semibold text-blue-600 mb-1">📌 파일명 규칙 감지</div>
                            <div className="text-text-secondary">이번 주 생성 시 파일명:</div>
                            <div className="font-mono text-text-primary mt-1 break-all">→ {templatePreview.preview}</div>
                            <div className="text-[10px] text-text-secondary mt-1">감지된 주차 부분: <code>{templatePreview.replacement}</code> · 현재 주차로 자동 치환됨</div>
                          </>
                        ) : (
                          <>
                            <div className="font-semibold text-amber-600 mb-1">⚠️ 파일명 규칙 미감지</div>
                            <div className="text-text-primary">파일명에서 주차/날짜 패턴을 찾을 수 없습니다. 기본 형식으로 생성됩니다:</div>
                            <div className="font-mono text-text-primary mt-1">→ [사업명] 2026년_N월_N주차_(D-D~D-D).hwpx</div>
                            <div className="text-[10px] text-text-secondary mt-1">원하는 파일명 규칙을 반영하려면 "7월 2주차", "2026-07-13" 같은 주차·날짜 정보가 포함된 파일명으로 다시 업로드하세요.</div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <button
                    className="w-full p-6 border-2 border-dashed border-border-color rounded-lg text-center text-text-secondary hover:border-accent hover:bg-accent/5 transition-colors"
                    onClick={onPickFile}
                  >
                    <Upload className="w-6 h-6 mx-auto mb-2" />
                    <div className="text-sm font-medium">.hwpx 파일 업로드</div>
                    <div className="text-xs mt-1">한글에서 다른 이름으로 저장 → .hwpx</div>
                  </button>
                )}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-xs text-text-primary">
                <div className="font-bold text-blue-500 mb-1">📌 발급 방법</div>
                SR 시스템 로그인 → <b>마이페이지 &gt; API 토큰</b> → <b>새 토큰 발급</b> → 발급된 값(<b>1회만 표시</b>)을 아래에 붙여넣기
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-text-primary block mb-1">
                    SR 시스템 URL <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={srBaseUrl}
                    onChange={(e) => setSrBaseUrl(e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-text-primary block mb-1">
                    테넌트 slug <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={srTenant}
                    onChange={(e) => setSrTenant(e.target.value)}
                    placeholder="sports"
                    className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                  <div className="text-xs text-text-secondary mt-1">API 경로의 {'{tenant}'} 값</div>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-text-primary block mb-1">
                  API 토큰 (Bearer) <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={srApiToken}
                  onChange={(e) => setSrApiToken(e.target.value)}
                  placeholder="srt_..."
                  className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                />
                <div className="text-xs text-text-secondary mt-1">srt_로 시작하는 값. 잃어버리면 재발급 필요.</div>
              </div>

              <div className="flex gap-2">
                <button
                  className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-primary hover:border-accent disabled:opacity-50"
                  onClick={testConnection}
                  disabled={testing || !canNext2}
                >
                  {testing ? '테스트 중...' : '형식 검증'}
                </button>
              </div>

              {testResult && (
                <div className={`p-3 rounded-lg text-xs ${testResult.ok ? 'bg-emerald-500/10 border border-emerald-500/40 text-emerald-500' : 'bg-red-500/10 border border-red-500/40 text-red-500'}`}>
                  <div className="font-bold mb-1">{testResult.ok ? '✓ 검증 통과' : '✗ 검증 실패'}</div>
                  <div>{testResult.detail}</div>
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <div className="p-4 rounded-lg border border-border-color bg-background space-y-2 text-sm">
                <Row label="사업 ID" value={<span className="font-mono">{id}</span>} />
                <Row label="사업명" value={name} />
                <Row label="발주기관" value={org} />
                {subtitle && <Row label="부제" value={subtitle} />}
                <Row label="수행업체" value={vendor} />
                <Row label="양식 파일" value={<span className="font-mono text-xs">{templateFile?.name}</span>} />
                <Row label="SR URL" value={<span className="font-mono text-xs">{srBaseUrl}</span>} />
                <Row label="테넌트" value={<span className="font-mono text-xs">{srTenant}</span>} />
                <Row label="API 토큰" value={<span className="font-mono text-xs">{srApiToken.slice(0, 8)}...{srApiToken.slice(-6)}</span>} />
              </div>
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-text-primary">
                <Key className="w-4 h-4 text-amber-500 inline mr-1" />
                본인 컨테이너(user{userNN})에만 저장됩니다. 다른 사원은 접근할 수 없습니다.
              </div>
            </>
          )}
        </div>

        <div className="flex justify-between items-center px-5 py-3 border-t border-border-color bg-background">
          <div className="text-xs text-text-secondary">🔒 user{userNN} 컨테이너에만 저장</div>
          <div className="flex gap-2">
            {step > 1 && (
              <button className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-primary hover:bg-card" onClick={() => setStep((step - 1) as Step)} disabled={saving}>
                ← 이전
              </button>
            )}
            <button className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-primary hover:bg-card" onClick={onClose} disabled={saving}>
              취소
            </button>
            {step < 3 ? (
              <button
                className="px-4 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg disabled:opacity-50"
                onClick={() => setStep((step + 1) as Step)}
                disabled={(step === 1 && !canNext1) || (step === 2 && !canNext2)}
              >
                다음 →
              </button>
            ) : (
              <button
                className="px-4 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg disabled:opacity-50 flex items-center gap-1"
                onClick={finish}
                disabled={saving}
              >
                <Check className="w-3.5 h-3.5" />
                {saving ? '등록 중...' : '등록 완료'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="text-xs text-text-secondary w-24 flex-shrink-0">{label}</div>
      <div className="text-sm text-text-primary flex-1 break-words">{value}</div>
    </div>
  );
}
