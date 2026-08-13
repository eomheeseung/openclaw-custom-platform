import { useState, useEffect, useCallback } from 'react';
import { BusinessReportSection } from './BusinessReportSection';

function getUserNN(): string {
  return (new URLSearchParams(window.location.search).get('token') || '').replace(/\D/g, '') || '01';
}

export function IntegrationsPage() {
  const [intState, setIntState] = useState<any>({ dooray: null, github: null, loading: true });
  const [doorayToken, setDoorayToken] = useState('');
  const [ghOwner, setGhOwner] = useState('');
  const [ghToken, setGhToken] = useState('');
  const [ghRepo, setGhRepo] = useState('');
  const [ghUsername, setGhUsername] = useState('');
  const [saving, setSaving] = useState('');
  const [figToken, setFigToken] = useState('');
  const [figUrls, setFigUrls] = useState('');
  const [figMsg, setFigMsg] = useState('');
  const [figExpires, setFigExpires] = useState('');

  const loadInt = useCallback(async () => {
    try {
      const r = await fetch('/api/integrations/load?userNN=' + getUserNN());
      const d = await r.json();
      if (d.ok) setIntState({ ...d.data, loading: false });
    } catch {
      setIntState((prev: any) => ({ ...prev, loading: false }));
    }
  }, []);

  useEffect(() => { loadInt(); }, [loadInt]);

  const saveDooray = async () => {
    if (!doorayToken.trim()) { alert('토큰을 입력해주세요'); return; }
    setSaving('dooray');
    try {
      const r = await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dooray: { token: doorayToken.trim() }, userNN: getUserNN() }),
      });
      const d = await r.json();
      if (d.ok) { setDoorayToken(''); await loadInt(); } else alert('저장 실패: ' + (d.error || ''));
    } catch (err: any) { alert('오류: ' + err.message); } finally { setSaving(''); }
  };

  const deleteDooray = async () => {
    if (!confirm('Dooray 연동을 해제하시겠습니까?')) return;
    setSaving('dooray-del');
    try {
      const r = await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dooray: { token: '', updatedAt: '' }, userNN: getUserNN() }),
      });
      const d = await r.json();
      if (d.ok) await loadInt(); else alert('실패: ' + (d.error || ''));
    } catch (err: any) { alert('오류: ' + err.message); } finally { setSaving(''); }
  };

  const saveGithub = async () => {
    if (!ghToken.trim()) { alert('토큰을 입력해주세요'); return; }
    setSaving('github');
    try {
      const r = await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github: { owner: ghOwner.trim(), token: ghToken.trim(), repo: ghRepo.trim(), username: ghUsername.trim() }, userNN: getUserNN() }),
      });
      const d = await r.json();
      if (d.ok) { setGhOwner(''); setGhToken(''); setGhRepo(''); await loadInt(); } else alert('저장 실패: ' + (d.error || ''));
    } catch (err: any) { alert('오류: ' + err.message); } finally { setSaving(''); }
  };

  const deleteGithub = async () => {
    if (!confirm('GitHub 연동을 해제하시겠습니까?')) return;
    setSaving('github-del');
    try {
      const r = await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github: { owner: '', token: '', repo: '', username: '', updatedAt: '' }, userNN: getUserNN() }),
      });
      const d = await r.json();
      if (d.ok) await loadInt(); else alert('실패: ' + (d.error || ''));
    } catch (err: any) { alert('오류: ' + err.message); } finally { setSaving(''); }
  };

  const saveFigmaToken = async () => {
    if (!figToken.trim()) { alert('토큰을 입력해주세요'); return; }
    setSaving('figma');
    try {
      await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figma: { token: figToken.trim(), expiresAt: figExpires || '' }, userNN: getUserNN() }),
      });
      setFigToken(''); setFigExpires(''); await loadInt();
    } finally { setSaving(''); }
  };

  /* URL 을 붙여넣으면 서버가 파일 키를 뽑고 이름을 조회한다.
     피그마는 사용자 기준 파일 목록 API 가 없어(명세 확인) 개별 등록 외에는 방법이 없다. */
  const addFigmaFiles = async () => {
    if (!figUrls.trim()) return;
    setSaving('figma-files'); setFigMsg('');
    try {
      const r = await fetch('/api/figma/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: figUrls, userNN: getUserNN() }),
      });
      const d = await r.json();
      if (!d.ok) { setFigMsg(d.error || '실패'); return; }
      const found = (d.files || []).filter((f: any) => f.ok);
      const prev = (intState.figma?.fileKeys || []) as Array<{ key: string; name: string }>;
      const merged = [...prev];
      for (const f of found) if (!merged.some(x => x.key === f.key)) merged.push({ key: f.key, name: f.name });
      await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figma: { fileKeys: merged }, userNN: getUserNN() }),
      });
      setFigUrls('');
      setFigMsg(found.length ? `${found.length}개 등록했어요` : '파일을 찾지 못했어요');
      await loadInt();
    } finally { setSaving(''); }
  };

  const removeFigmaFile = async (key: string) => {
    const prev = (intState.figma?.fileKeys || []) as Array<{ key: string; name: string }>;
    await fetch('/api/integrations/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figma: { fileKeys: prev.filter(x => x.key !== key) }, userNN: getUserNN() }),
    });
    await loadInt();
  };

  /* 피그마 개인 토큰은 최대 90일이다. 만료를 놓치면 수집이 조용히 멈추므로 남은 날을 눈에 띄게 둔다. */
  const figDday = (() => {
    const raw = intState.figma?.expiresAt;
    if (!raw) return null;
    const days = Math.ceil((new Date(raw + 'T23:59:59').getTime() - Date.now()) / 86400000);
    return { days, raw };
  })();

  const isFigmaConnected = intState.figma && intState.figma.token && intState.figma.token !== '••••';
  const figFiles = (intState.figma?.fileKeys || []) as Array<{ key: string; name: string }>;

  const isDoorayConnected = intState.dooray && intState.dooray.token && intState.dooray.token !== '••••';
  const isGithubConnected = intState.github && intState.github.token && intState.github.token !== '••••';

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-xl font-bold text-text-primary mb-2">외부 연동</h2>
      <p className="text-sm text-text-secondary mb-6">외부 서비스 API를 연동하여 AI 에이전트가 활용할 수 있게 합니다.</p>

      {intState.loading ? (
        <div className="text-text-secondary text-sm">로딩 중...</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Dooray */}
          <div className="bg-card border border-border-color rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm" style={{ background: 'linear-gradient(135deg, #4A90D9, #357ABD)' }}>D</div>
                <div>
                  <h3 className="font-semibold text-text-primary">Dooray</h3>
                  <p className="text-xs text-text-secondary">NHN Dooray 프로젝트 연동</p>
                </div>
              </div>
              {isDoorayConnected ? (
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">연결됨</span>
              ) : (
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-gray-500/10 text-text-secondary border border-border-color">미연결</span>
              )}
            </div>

            {isDoorayConnected ? (
              <div>
                <div className="bg-background rounded-lg p-4 mb-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-text-secondary">토큰</span>
                    <span className="text-xs font-mono text-text-secondary">{intState.dooray.token}</span>
                  </div>
                  {intState.dooray.updatedAt && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-secondary">연동일시</span>
                      <span className="text-xs text-text-secondary">{new Date(intState.dooray.updatedAt).toLocaleString('ko-KR')}</span>
                    </div>
                  )}
                </div>
                <button className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors" disabled={saving === 'dooray-del'} onClick={deleteDooray}>
                  {saving === 'dooray-del' ? '해제 중...' : '연동 해제'}
                </button>
              </div>
            ) : (
              <div>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-text-secondary block mb-1">API 인증 토큰</label>
                    <input type="password" value={doorayToken} onChange={(e) => setDoorayToken(e.target.value)} placeholder="Dooray 설정 > API > 개인 인증 토큰"
                      className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                  <button className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors" disabled={saving === 'dooray'} onClick={saveDooray}>
                    {saving === 'dooray' ? '저장 중...' : '연결'}
                  </button>
                </div>
                <div className="mt-4 p-3 bg-background rounded-lg">
                  <p className="text-xs font-medium text-text-secondary mb-2">토큰 발급 방법</p>
                  <ol className="text-xs text-text-secondary space-y-1 list-decimal list-inside">
                    <li>웹브라우저에서 두레이 접속</li>
                    <li>우측 상단 설정 아이콘 → 서비스설정 클릭</li>
                    <li>좌측의 API 선택</li>
                    <li>인증 토큰 생성하기 (용도는 아무거나)</li>
                  </ol>
                </div>
              </div>
            )}
          </div>

          {/* GitHub */}
          <div className="bg-card border border-border-color rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm" style={{ background: 'linear-gradient(135deg, #555, #333)' }}>GH</div>
                <div>
                  <h3 className="font-semibold text-text-primary">GitHub</h3>
                  <p className="text-xs text-text-secondary">저장소, 이슈, PR 연동</p>
                </div>
              </div>
              {isGithubConnected ? (
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">연결됨</span>
              ) : (
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-gray-500/10 text-text-secondary border border-border-color">미연결</span>
              )}
            </div>

            {isGithubConnected ? (
              <div>
                <div className="bg-background rounded-lg p-4 mb-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-secondary">토큰</span>
                    <span className="text-xs font-mono text-text-secondary">{intState.github.token}</span>
                  </div>
                  {intState.github.owner && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-secondary">Owner</span>
                      <span className="text-xs text-text-secondary">{intState.github.owner}</span>
                    </div>
                  )}
                  {intState.github.updatedAt && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-secondary">연동일시</span>
                      <span className="text-xs text-text-secondary">{new Date(intState.github.updatedAt).toLocaleString('ko-KR')}</span>
                    </div>
                  )}
                </div>
                <button className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors" disabled={saving === 'github-del'} onClick={deleteGithub}>
                  {saving === 'github-del' ? '해제 중...' : '연동 해제'}
                </button>
              </div>
            ) : (
              <div>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-text-secondary block mb-1">Owner / Organization (선택)</label>
                    <input type="text" value={ghOwner} onChange={(e) => setGhOwner(e.target.value)} placeholder="비워두면 모든 조직에서 본인 커밋을 찾습니다"
                      className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-text-secondary block mb-1">Personal Access Token</label>
                    <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder="ghp_xxxxxxxxxxxx"
                      className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-text-secondary block mb-1">GitHub Username (본인 계정명)</label>
                    <input type="text" value={ghUsername} onChange={(e) => setGhUsername(e.target.value)} placeholder="예: jaemin-son — 업무보고에서 본인 커밋만 집계할 때 필요"
                      className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                    <p className="text-[11px] text-text-secondary mt-1"><b>필수</b> — 공용 저장소에서 팀원 커밋이 섞이지 않도록 본인 커밋만 골라냅니다. 없으면 GitHub 수집을 건너뜁니다.</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-text-secondary block mb-1">Repository (선택 · 보통 비워둡니다)</label>
                    <input type="text" value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} placeholder="특정 저장소만 보고 싶을 때만 입력"
                      className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                  <button className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors" disabled={saving === 'github'} onClick={saveGithub}>
                    {saving === 'github' ? '저장 중...' : '연결'}
                  </button>
                </div>
                <div className="mt-4 p-3 bg-background rounded-lg">
                  <p className="text-xs font-medium text-text-secondary mb-2">토큰 발급 방법</p>
                  <ol className="text-xs text-text-secondary space-y-1 list-decimal list-inside">
                    <li>GitHub.com → Settings</li>
                    <li>Developer settings → Personal access tokens</li>
                    <li>Generate new token (classic)</li>
                  </ol>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ 피그마 ═══ */}
      <div className="bg-card border border-border-color rounded-xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">🎨</span>
            <h3 className="text-base font-bold">피그마</h3>
          </div>
          <div className="flex items-center gap-2">
            {isFigmaConnected && figDday && (
              <span className={`text-xs font-medium px-2 py-1 rounded-full border ${
                figDday.days < 0 ? 'bg-red-500/10 text-red-500 border-red-500/25'
                : figDday.days <= 7 ? 'bg-red-500/10 text-red-500 border-red-500/25'
                : figDday.days <= 30 ? 'bg-amber-500/10 text-amber-600 border-amber-500/25'
                : 'bg-gray-500/10 text-text-secondary border-border-color'}`}>
                {figDday.days < 0 ? `만료됨 (${figDday.raw})` : `토큰 D-${figDday.days} · ${figDday.raw}`}
              </span>
            )}
            {isFigmaConnected
              ? <span className="text-xs font-medium px-2 py-1 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">연결됨</span>
              : <span className="text-xs font-medium px-2 py-1 rounded-full bg-gray-500/10 text-text-secondary border border-border-color">미연결</span>}
          </div>
        </div>

        {!isFigmaConnected ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input type="password" value={figToken} onChange={(e) => setFigToken(e.target.value)}
                placeholder="figd_ 로 시작하는 개인 액세스 토큰"
                className="flex-1 px-3 py-2 bg-background border border-border-color rounded-lg text-sm" />
              <input type="date" value={figExpires} onChange={(e) => setFigExpires(e.target.value)}
                title="토큰 만료일 (발급 화면에 표시됩니다)"
                className="px-3 py-2 bg-background border border-border-color rounded-lg text-sm" />
              <button className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg"
                disabled={saving === 'figma'} onClick={saveFigmaToken}>
                {saving === 'figma' ? '저장 중...' : '저장'}
              </button>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">
              피그마 → Settings → Security → Personal access tokens → Generate new token<br />
              권한은 <span className="font-mono">current_user:read</span>, <span className="font-mono">file_metadata:read</span>,
              {' '}<span className="font-mono">file_versions:read</span> 세 가지면 됩니다. 만료는 최대 90일입니다.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-xs font-semibold text-text-secondary mb-1.5">작업 파일 등록</div>
              <textarea value={figUrls} onChange={(e) => setFigUrls(e.target.value)} rows={3}
                placeholder={'피그마 파일 주소를 붙여넣으세요 (여러 줄 가능)\nhttps://www.figma.com/design/.../파일명'}
                className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm font-mono" />
              <div className="flex items-center gap-2 mt-2">
                <button className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg"
                  disabled={saving === 'figma-files'} onClick={addFigmaFiles}>
                  {saving === 'figma-files' ? '확인 중...' : '추가'}
                </button>
                {figMsg && <span className="text-xs text-text-secondary">{figMsg}</span>}
              </div>
              <p className="text-xs text-text-secondary mt-1.5">
                주소 안의 <span className="font-mono">node-id</span> 는 신경 쓰지 않아도 됩니다 — 같은 파일이면 하나로 묶입니다.
              </p>
            </div>

            {figFiles.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-text-secondary mb-1.5">등록된 파일 {figFiles.length}개</div>
                <div className="space-y-1">
                  {figFiles.map(f => (
                    <div key={f.key} className="flex items-center justify-between bg-background rounded-lg px-3 py-2">
                      <span className="text-sm">{f.name}</span>
                      <button className="text-xs text-red-500 hover:underline" onClick={() => removeFigmaFile(f.key)}>삭제</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <BusinessReportSection userNN={getUserNN()} />
    </div>
  );
}
