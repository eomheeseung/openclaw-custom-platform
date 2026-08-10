import { useState, useEffect, useCallback, useRef } from 'react';
import { Building2, Plus, ChevronLeft, Pencil, Trash2, RefreshCw, CheckCircle2, AlertCircle, Upload } from 'lucide-react';
import { NewBusinessModal } from './NewBusinessModal';

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(bin);
}

interface Props {
  userNN: string;
}

interface ProjectStatus {
  auth_ok: boolean;
  auth_masked: string | null;
  base_url: string | null;
  tenant: string | null;
  template_exists: boolean;
  template_size: number;
  template_original_filename?: string | null;
  filename_rule_set?: boolean;
}

interface Project {
  id: string;
  name: string;
  org: string;
  subtitle?: string;
  vendor?: string;
  week_rule?: string;
  auto_run?: boolean;
  archived?: boolean;
  created_at?: string;
  updated_at?: string;
  status: ProjectStatus;
}

export function BusinessReportSection({ userNN }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/business-report/projects?userNN=${userNN}`);
      const d = await r.json();
      if (d.ok) {
        setProjects(d.projects || []);
      }
    } finally {
      setLoading(false);
    }
  }, [userNN]);

  useEffect(() => { load(); }, [load]);

  if (selectedId) {
    const proj = projects.find(p => p.id === selectedId);
    if (proj) return <BusinessProjectDetail userNN={userNN} project={proj} onBack={() => { setSelectedId(null); load(); }} onDeleted={() => { setSelectedId(null); load(); }} />;
  }

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Building2 className="w-4 h-4 text-text-secondary" />
          <h3 className="text-xs font-bold text-text-secondary uppercase tracking-wider">공공사업 시스템</h3>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full bg-card border border-border-color text-text-secondary">
          {loading ? '...' : `${projects.length}개 등록됨`}
        </span>
      </div>

      {loading ? (
        <div className="text-text-secondary text-sm">로딩 중...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {projects.map(p => (
            <BusinessCard key={p.id} project={p} onClick={() => setSelectedId(p.id)} />
          ))}
          <button
            className="border-2 border-dashed border-border-color rounded-xl min-h-[150px] flex flex-col items-center justify-center text-text-secondary hover:border-accent hover:text-accent hover:bg-accent/5 transition-colors"
            onClick={() => setShowAdd(true)}
          >
            <Plus className="w-8 h-8 mb-2" strokeWidth={1.5} />
            <div className="text-sm font-semibold">새 사업 추가</div>
            <div className="text-xs mt-1">사업명 · 발주기관 · SR URL · HWPX 양식</div>
          </button>
        </div>
      )}

      {showAdd && (
        <NewBusinessModal
          userNN={userNN}
          onClose={() => setShowAdd(false)}
          onCreated={load}
        />
      )}
    </div>
  );
}

function BusinessCard({ project, onClick }: { project: Project; onClick: () => void }) {
  const st = project.status;
  return (
    <button
      onClick={onClick}
      className="text-left bg-card border border-border-color rounded-xl p-4 hover:border-accent hover:shadow-md transition-all flex flex-col gap-2"
    >
      <div className="flex gap-3 items-start">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-accent/10 to-purple-500/10 flex items-center justify-center flex-shrink-0">
          <Building2 className="w-5 h-5 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm text-text-primary leading-snug line-clamp-2">{project.name}</div>
          <div className="text-xs text-text-secondary mt-0.5 truncate">{project.subtitle || project.org}</div>
        </div>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {project.archived ? (
          <Chip>아카이브</Chip>
        ) : (
          <>
            <Chip variant={st.auth_ok ? 'ok' : 'warn'}>{st.auth_ok ? 'SR 연결됨' : 'SR 인증 필요'}</Chip>
            <Chip variant={st.template_exists ? 'ok' : 'warn'}>{st.template_exists ? '양식 정상' : '양식 없음'}</Chip>
            {st.template_exists && !st.filename_rule_set && <Chip variant="warn">파일명 규칙 미설정</Chip>}
            {project.auto_run && <Chip>자동 발송 ON</Chip>}
          </>
        )}
      </div>
      <div className="flex gap-3 text-xs text-text-secondary pt-2 border-t border-dashed border-border-color mt-1">
        <div className="flex-1">
          <div className="font-mono text-text-primary text-xs truncate">{project.id}</div>
          <div>사업 ID</div>
        </div>
        <div className="flex-1">
          <div className="text-text-primary">{project.org}</div>
          <div>발주기관</div>
        </div>
      </div>
    </button>
  );
}

function Chip({ children, variant }: { children: React.ReactNode; variant?: 'ok' | 'warn' }) {
  const cls =
    variant === 'ok'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : variant === 'warn'
      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-500'
      : 'bg-gray-500/15 text-text-secondary';
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{children}</span>;
}

function BusinessProjectDetail({ userNN, project, onBack, onDeleted }: { userNN: string; project: Project; onBack: () => void; onDeleted: () => void }) {
  const [editingAuth, setEditingAuth] = useState(false);
  const [srBaseUrl, setSrBaseUrl] = useState(project.status.base_url || 'https://sr.tideflo.work');
  const [srTenant, setSrTenant] = useState(project.status.tenant || '');
  const [srApiToken, setSrApiToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [editingMeta, setEditingMeta] = useState(false);
  const [name, setName] = useState(project.name);
  const [org, setOrg] = useState(project.org);
  const [subtitle, setSubtitle] = useState(project.subtitle || '');
  const [vendor, setVendor] = useState(project.vendor || '');

  const fileRef = useRef<HTMLInputElement>(null);
  const [templateMsg, setTemplateMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [templatePreview, setTemplatePreview] = useState<{ detected: boolean; preview?: string | null; replacement?: string } | null>(null);

  const saveMeta = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/business-report/projects/${encodeURIComponent(project.id)}?userNN=${userNN}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), org: org.trim(), subtitle: subtitle.trim(), vendor: vendor.trim(), userNN }),
      });
      const d = await r.json();
      if (d.ok) { setEditingMeta(false); onBack(); }
      else alert('저장 실패: ' + (d.error || ''));
    } finally { setSaving(false); }
  };

  const [localTemplateInfo, setLocalTemplateInfo] = useState<{ size: number; filename: string; updatedAt: string } | null>(null);

  const uploadTemplate = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.hwpx')) { setTemplateMsg({ ok: false, text: '.hwpx 파일만 업로드 가능' }); return; }
    if (file.size > 20 * 1024 * 1024) { setTemplateMsg({ ok: false, text: '20MB 이하로 업로드' }); return; }
    setSaving(true);
    setTemplateMsg(null);
    setTemplatePreview(null);
    try {
      const buf = await file.arrayBuffer();
      const base64 = bufToBase64(buf);
      const r = await fetch(`/api/business-report/projects/${encodeURIComponent(project.id)}?userNN=${userNN}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_base64: base64, template_filename: file.name, userNN }),
      });
      const d = await r.json();
      if (d.ok) {
        const now = new Date().toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setTemplateMsg({ ok: true, text: `✓ ${file.name} (${(file.size/1024).toFixed(1)} KB) 교체 완료 · ${now}` });
        setLocalTemplateInfo({ size: file.size, filename: file.name, updatedAt: now });
        /* 파일명 규칙 미리보기 */
        try {
          const pr = await fetch('/api/business-report/preview-filename', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: file.name }),
          });
          const pd = await pr.json();
          if (pd.ok) setTemplatePreview({ detected: !!pd.detected, preview: pd.preview, replacement: pd.replacement });
        } catch { /* ignore */ }
      } else {
        setTemplateMsg({ ok: false, text: d.error || '교체 실패' });
      }
    } catch (e: any) { setTemplateMsg({ ok: false, text: e.message }); }
    finally { setSaving(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const saveAuth = async () => {
    if (!srBaseUrl.trim() || !srTenant.trim() || !srApiToken.trim()) { setTestMsg({ ok: false, text: '모든 필드 입력' }); return; }
    setSaving(true);
    setTestMsg(null);
    try {
      const r = await fetch(`/api/business-report/projects/${encodeURIComponent(project.id)}/auth?userNN=${userNN}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ SR_BASE_URL: srBaseUrl.trim(), SR_TENANT: srTenant.trim(), SR_API_TOKEN: srApiToken.trim(), userNN }),
      });
      const d = await r.json();
      if (d.ok) {
        setEditingAuth(false);
        setSrApiToken('');
        onBack();
      } else {
        setTestMsg({ ok: false, text: d.error || '저장 실패' });
      }
    } finally { setSaving(false); }
  };

  const testConnection = async () => {
    setSaving(true);
    setTestMsg(null);
    try {
      const r = await fetch(`/api/business-report/projects/${encodeURIComponent(project.id)}/test-connection?userNN=${userNN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userNN }),
      });
      const d = await r.json();
      setTestMsg({ ok: !!d.ok, text: `HTTP ${d.http_status} · ${d.detail || (d.ok ? '연결 성공' : '실패')}` });
    } catch (e: any) {
      setTestMsg({ ok: false, text: e.message });
    } finally { setSaving(false); }
  };

  const deleteProject = async () => {
    if (!confirm(`정말로 '${project.name}' 사업을 삭제할까요?\n템플릿과 이력이 모두 삭제됩니다.`)) return;
    const r = await fetch(`/api/business-report/projects/${encodeURIComponent(project.id)}?userNN=${userNN}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) onDeleted();
    else alert('삭제 실패: ' + (d.error || ''));
  };

  return (
    <div className="mt-4">
      <button className="flex items-center gap-1 text-xs text-text-secondary hover:text-accent mb-3" onClick={onBack}>
        <ChevronLeft className="w-3.5 h-3.5" />
        외부 연동 › 공공사업 시스템 › {project.id}
      </button>

      <div className="bg-card border border-border-color rounded-xl p-5">
        <div className="flex justify-between items-start mb-4">
          <div className="flex gap-3 items-center">
            <div className="w-11 h-11 rounded-lg bg-gradient-to-br from-accent/10 to-purple-500/10 flex items-center justify-center">
              <Building2 className="w-6 h-6 text-accent" />
            </div>
            <div>
              <div className="font-bold text-sm text-text-primary">{project.name}</div>
              <div className="text-xs text-text-secondary mt-0.5">
                {project.subtitle && <>{project.subtitle} · </>}
                사업 ID: <code className="font-mono bg-background px-1.5 py-0.5 rounded">{project.id}</code>
              </div>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              className="px-2.5 py-1 text-xs border border-border-color rounded-lg text-text-primary hover:border-accent hover:text-accent flex items-center gap-1"
              title="편집"
              onClick={() => setEditingMeta(!editingMeta)}
            >
              <Pencil className="w-3.5 h-3.5" />
              {editingMeta ? '취소' : '편집'}
            </button>
            <button className="px-2.5 py-1 text-xs border border-border-color rounded-lg text-text-primary hover:border-red-500 hover:text-red-500 flex items-center gap-1" onClick={deleteProject}>
              <Trash2 className="w-3.5 h-3.5" />
              삭제
            </button>
          </div>
        </div>

        {editingMeta ? (
          <div className="space-y-2 p-3 rounded-lg bg-background border border-border-color">
            <div>
              <label className="text-xs text-text-secondary block mb-1">사업명</label>
              <input value={name} onChange={e => setName(e.target.value)} className="w-full px-2 py-1.5 bg-white border border-border-color rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-text-secondary block mb-1">발주기관</label>
                <input value={org} onChange={e => setOrg(e.target.value)} className="w-full px-2 py-1.5 bg-white border border-border-color rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div>
                <label className="text-xs text-text-secondary block mb-1">수행업체</label>
                <input value={vendor} onChange={e => setVendor(e.target.value)} className="w-full px-2 py-1.5 bg-white border border-border-color rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">부제</label>
              <input value={subtitle} onChange={e => setSubtitle(e.target.value)} className="w-full px-2 py-1.5 bg-white border border-border-color rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
            <div className="flex gap-2 pt-1">
              <button className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg disabled:opacity-50" onClick={saveMeta} disabled={saving}>{saving ? '저장 중...' : '저장'}</button>
              <button className="px-3 py-1.5 text-xs border border-border-color text-text-primary rounded-lg" onClick={() => setEditingMeta(false)}>취소</button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[130px_1fr] gap-y-2 gap-x-4 text-xs">
            <div className="text-text-secondary">발주기관</div><div className="text-text-primary">{project.org}</div>
            <div className="text-text-secondary">수행업체</div><div className="text-text-primary">{project.vendor || '-'}</div>
            <div className="text-text-secondary">SR 시스템</div><div className="text-text-primary font-mono">{project.status.base_url || '-'}</div>
            <div className="text-text-secondary">테넌트</div><div className="text-text-primary font-mono">{project.status.tenant || '-'}</div>
            <div className="text-text-secondary">인증 방식</div>
            <div className="text-text-primary flex items-center gap-2">
              Bearer 토큰 ·
              {project.status.auth_ok
                ? <><Chip variant="ok">활성</Chip><span className="font-mono text-text-secondary">{project.status.auth_masked}</span></>
                : <Chip variant="warn">미설정</Chip>}
            </div>
            <div className="text-text-secondary">주차 규칙</div><div className="text-text-primary">{project.week_rule === 'mon-fri' ? '월요일 ~ 금요일' : project.week_rule}</div>
            <div className="text-text-secondary">등록일</div><div className="text-text-primary">{project.created_at?.slice(0, 10) || '-'}</div>
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-dashed border-border-color">
          <div className="flex justify-between items-center mb-3">
            <h5 className="text-sm font-bold text-text-primary flex items-center gap-1.5">
              🔑 SR 인증
            </h5>
            {!editingAuth && <button className="text-xs text-accent hover:underline" onClick={() => setEditingAuth(true)}>{project.status.auth_ok ? '재등록' : '등록'}</button>}
          </div>

          {editingAuth ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-text-secondary block mb-1">SR URL</label>
                  <input value={srBaseUrl} onChange={e => setSrBaseUrl(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border-color rounded text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
                <div>
                  <label className="text-xs text-text-secondary block mb-1">테넌트</label>
                  <input value={srTenant} onChange={e => setSrTenant(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border-color rounded text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                </div>
              </div>
              <div>
                <label className="text-xs text-text-secondary block mb-1">API 토큰 (srt_...)</label>
                <input type="password" value={srApiToken} onChange={e => setSrApiToken(e.target.value)} className="w-full px-2 py-1.5 bg-background border border-border-color rounded text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div className="flex gap-2">
                <button className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg disabled:opacity-50" onClick={saveAuth} disabled={saving}>{saving ? '저장 중...' : '저장'}</button>
                <button className="px-3 py-1.5 text-xs border border-border-color text-text-primary rounded-lg" onClick={() => { setEditingAuth(false); setSrApiToken(''); }}>취소</button>
              </div>
            </div>
          ) : (
            project.status.auth_ok && (
              <div className="flex items-center gap-2">
                <button className="px-3 py-1.5 text-xs border border-border-color text-text-primary rounded-lg hover:border-accent flex items-center gap-1" onClick={testConnection} disabled={saving}>
                  <RefreshCw className="w-3.5 h-3.5" />
                  연결 테스트
                </button>
                {testMsg && (
                  <div className={`text-xs flex items-center gap-1 ${testMsg.ok ? 'text-emerald-500' : 'text-red-500'}`}>
                    {testMsg.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                    {testMsg.text}
                  </div>
                )}
              </div>
            )
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-dashed border-border-color">
          <h5 className="text-sm font-bold text-text-primary mb-2 flex items-center gap-1.5">
            📄 주간보고 양식
          </h5>

          {/* 파일명 규칙 미설정 안내 배너 */}
          {project.status.template_exists && !project.status.filename_rule_set && !localTemplateInfo && (
            <div className="mb-3 p-3 rounded-lg bg-amber-500/10 border-l-4 border-amber-500 text-xs text-text-primary">
              <div className="font-semibold text-amber-700 mb-1 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                파일명 규칙 미설정
              </div>
              <div className="text-text-secondary">
                양식을 재업로드하면 원본 파일명 스타일이 다음 생성 파일에 자동 반영됩니다.
                예: <code>[사업명] 7월 2주차 주간보고서.hwpx</code> → 이번 주엔 <code>7월 2주차</code>가 이번 주차로 자동 치환.
              </div>
              <div className="text-text-secondary mt-1 text-[10px]">
                현재는 기본 형식(<code>[사업명] N년_N월_N주차_(D-D~D-D).hwpx</code>)으로 생성됨.
              </div>
            </div>
          )}

          <div className="flex gap-3 items-center bg-background border border-border-color rounded-lg p-3">
            <div className="w-14 h-14 border border-border-color rounded flex items-center justify-center text-2xl text-text-secondary bg-card flex-shrink-0">
              📄
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-mono text-text-primary truncate">
                {localTemplateInfo?.filename || project.status.template_original_filename || 'template.hwpx'}
              </div>
              <div className="text-xs text-text-secondary mt-0.5">
                {localTemplateInfo
                  ? `${(localTemplateInfo.size / 1024).toFixed(1)} KB · 방금 교체 (${localTemplateInfo.updatedAt})`
                  : project.status.template_exists
                    ? `${(project.status.template_size / 1024).toFixed(1)} KB · 저장됨`
                    : '파일 없음'}
              </div>
            </div>
            <div className="flex flex-col gap-1 flex-shrink-0">
              <input
                ref={fileRef}
                type="file"
                accept=".hwpx"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadTemplate(f); }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={saving}
                className="px-2.5 py-1 text-xs border border-border-color rounded-lg text-text-primary hover:border-accent flex items-center gap-1 disabled:opacity-50"
              >
                <Upload className="w-3 h-3" />
                {saving ? '업로드 중...' : '교체'}
              </button>
            </div>
          </div>
          {templateMsg && (
            <div className={`mt-2 text-xs flex items-center gap-1 ${templateMsg.ok ? 'text-emerald-500' : 'text-red-500'}`}>
              {templateMsg.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              {templateMsg.text}
            </div>
          )}
          {templatePreview && (
            <div className={`mt-2 p-3 rounded-lg text-xs ${templatePreview.detected ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-amber-500/10 border border-amber-500/30'}`}>
              {templatePreview.detected ? (
                <>
                  <div className="font-semibold text-blue-600 mb-1">📌 파일명 규칙 감지</div>
                  <div className="text-text-secondary">이번 주 생성 시 파일명:</div>
                  <div className="font-mono text-text-primary mt-1 break-all">→ {templatePreview.preview}</div>
                  <div className="text-[10px] text-text-secondary mt-1">감지된 주차 부분 <code>{templatePreview.replacement}</code> 이 현재 주차로 자동 치환됨</div>
                </>
              ) : (
                <>
                  <div className="font-semibold text-amber-600 mb-1">⚠️ 파일명 규칙 미감지</div>
                  <div className="text-text-primary">파일명에 주차/날짜 패턴이 없어 기본 형식으로 생성됩니다.</div>
                  <div className="text-[10px] text-text-secondary mt-1">파일명에 <code>7월 2주차</code> 또는 <code>2026-07-13</code> 같은 정보 포함해 다시 업로드하세요.</div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
