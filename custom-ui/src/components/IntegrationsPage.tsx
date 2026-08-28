import { useState, useEffect, useCallback } from 'react';
import { BusinessReportSection } from './BusinessReportSection';

function getUserNN(): string {
  return (new URLSearchParams(window.location.search).get('token') || '').replace(/\D/g, '') || '01';
}

/** 발급 기간(일)으로 만료일을 계산한다. 피그마는 날짜가 아니라 기간을 고르게 되어 있다. */
function expiryFromDays(days: string): string {
  if (!days) return '';
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

export function IntegrationsPage() {
  const [intState, setIntState] = useState<any>({ dooray: null, github: null, loading: true });
  const [ghAdding, setGhAdding] = useState(false);   // 계정을 하나 더 붙이는 중
  const [doorayToken, setDoorayToken] = useState('');
  /* 봇 URL — 알림이 나가는 주소. 없으면 아침 브리핑도 두레이 수신도 동작하지 않는다 */
  const [botUrl, setBotUrl] = useState('');
  const [botMsg, setBotMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [botBusy, setBotBusy] = useState(false);
  const [ghOwner, setGhOwner] = useState('');
  const [ghToken, setGhToken] = useState('');
  const [ghRepo, setGhRepo] = useState('');
  const [ghUsername, setGhUsername] = useState('');
  const [saving, setSaving] = useState('');
  const [figToken, setFigToken] = useState('');
  const [figUrls, setFigUrls] = useState('');
  const [figMsg, setFigMsg] = useState('');
  const [figDays, setFigDays] = useState('90');
  const [figOpen, setFigOpen] = useState(false);   // 피그마 발급 화면의 기간 선택과 맞춘다

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

  const saveBotUrl = async () => {
    const v = botUrl.trim();
    if (!v) { setBotMsg({ ok: false, text: '봇 URL 을 입력해주세요' }); return; }
    setBotBusy(true); setBotMsg(null);
    try {
      const r = await fetch('/api/integrations/save', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dooray: { botUrl: v }, userNN: getUserNN() }),
      });
      const d = await r.json();
      if (!d.ok) { setBotMsg({ ok: false, text: d.error || '저장 실패' }); return; }
      // 저장만 하고 끝내면 잘못된 URL 을 며칠 뒤에야 안다 — 바로 보내본다
      const t = await fetch('/api/dooray/bot-test', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botUrl: v, userNN: getUserNN() }),
      }).then(x => x.json());
      setBotMsg(t.ok
        ? { ok: true, text: '두레이로 테스트 메시지를 보냈습니다. 확인해주세요' }
        : { ok: false, text: `저장은 됐지만 발송에 실패했습니다 — ${t.error || ''}` });
      await loadInt();
    } catch (e) { setBotMsg({ ok: false, text: String(e) }); }
    finally { setBotBusy(false); }
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

  /** 이미 연결된 사람이 계정을 하나 더 붙이는 중인지. 회사·개인 계정을 나눠 쓰는 사람이 있다. */
  const ghAccounts: any[] = intState.github?.accounts?.length
    ? intState.github.accounts
    : (intState.github?.token ? [intState.github] : []);

  const saveGithub = async () => {
    if (!ghToken.trim()) { alert('토큰을 입력해주세요'); return; }
    setSaving('github');
    try {
      const r = await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github: ghAdding
          // 계정 추가: 기존 목록 뒤에 붙인다. 기존 항목의 토큰은 '••••' 로 내려온 값을
          // 그대로 돌려보내고, 서버가 저장돼 있던 진짜 토큰으로 되살린다.
          ? { accounts: [...ghAccounts.map((a: any) => ({ owner: a.owner || '', repo: a.repo || '', username: a.username || '', token: a.token })),
                         { owner: ghOwner.trim(), token: ghToken.trim(), repo: ghRepo.trim(), username: ghUsername.trim() }] }
          : { owner: ghOwner.trim(), token: ghToken.trim(), repo: ghRepo.trim(), username: ghUsername.trim() },
          userNN: getUserNN() }),
      });
      const d = await r.json();
      if (d.ok) { setGhOwner(''); setGhToken(''); setGhRepo(''); setGhUsername(''); setGhAdding(false); await loadInt(); } else alert('저장 실패: ' + (d.error || ''));
    } catch (err: any) { alert('오류: ' + err.message); } finally { setSaving(''); }
  };

  /** 계정 하나만 뺀다. 남은 계정의 토큰은 '••••' 로 보내고 서버가 되살린다. */
  const removeGhAccount = async (idx: number) => {
    const target = ghAccounts[idx];
    if (!confirm(`${target?.username || target?.owner || '이 계정'} 연동을 삭제할까요?`)) return;
    setSaving('github');
    try {
      const rest = ghAccounts.filter((_: any, i: number) => i !== idx)
        .map((a: any) => ({ owner: a.owner || '', repo: a.repo || '', username: a.username || '', token: a.token }));
      const r = await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github: { accounts: rest }, userNN: getUserNN() }),
      });
      const d = await r.json();
      if (d.ok) await loadInt(); else alert('삭제 실패: ' + (d.error || ''));
    } catch (err: any) { alert('오류: ' + err.message); } finally { setSaving(''); }
  };

  const deleteGithub = async () => {
    if (!confirm('GitHub 연동을 해제하시겠습니까?')) return;
    setSaving('github-del');
    try {
      const r = await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github: { owner: '', token: '', repo: '', username: '', accounts: [], updatedAt: '' }, userNN: getUserNN() }),
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
        body: JSON.stringify({ figma: { token: figToken.trim(), expiresAt: expiryFromDays(figDays) }, userNN: getUserNN() }),
      });
      setFigToken(''); await loadInt();
    } finally { setSaving(''); }
  };

  /* URL 을 붙여넣으면 서버가 파일 키를 뽑고 이름을 조회한다.
     피그마는 사용자 기준 파일 목록 API 가 없어(명세 확인) 개별 등록 외에는 방법이 없다. */
  const addFigmaFiles = async () => {
    if (!figUrls.trim()) { setFigMsg('주소를 입력해주세요'); return; }
    setSaving('figma-files'); setFigMsg('');
    try {
      const r = await fetch('/api/figma/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: figUrls, userNN: getUserNN() }),
      });
      if (!r.ok) { setFigMsg(`서버 오류 (${r.status})`); return; }
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
      setFigMsg(found.length ? `${found.length}개 등록했어요` : '주소에서 파일을 찾지 못했어요');
      await loadInt();
    } catch (e) {
      setFigMsg('요청 실패 — ' + String(e).slice(0, 60));
    } finally { setSaving(''); }
  };

  const deleteFigma = async () => {
    setSaving('figma-del');
    try {
      await fetch('/api/integrations/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figma: { token: '', expiresAt: '', userId: '', handle: '', fileKeys: [], updatedAt: '' }, userNN: getUserNN() }),
      });
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
                <div className="bg-background rounded-lg p-4 mb-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-text-primary">봇 URL</span>
                    {intState.dooray.botUrl
                      ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">등록됨</span>
                      : <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20">필요</span>}
                  </div>
                  <p className="text-[11px] text-text-secondary mb-2">
                    아침 브리핑과 작업 완료 알림이 이 주소로 갑니다. 등록하지 않으면 두레이로 지시하는 것도 동작하지 않습니다.
                  </p>
                  <div className="flex gap-2">
                    <input value={botUrl || intState.dooray.botUrl || ''} onChange={(e) => setBotUrl(e.target.value)}
                      placeholder="https://tideflo.dooray.com/services/..."
                      className="flex-1 px-3 py-2 bg-card border border-border-color rounded-lg text-sm font-mono text-text-primary placeholder-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                    <button className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                      disabled={botBusy} onClick={saveBotUrl}>
                      {botBusy ? '확인 중...' : '저장 + 테스트'}
                    </button>
                  </div>
                  {botMsg && (
                    <p className={`text-[11px] mt-2 ${botMsg.ok ? 'text-green-500' : 'text-red-500'}`}>{botMsg.text}</p>
                  )}
                  <details className="mt-2">
                    <summary className="text-[11px] text-text-secondary cursor-pointer">봇 URL 받는 방법</summary>
                    <ol className="text-[11px] text-text-secondary space-y-1 list-decimal list-inside mt-1">
                      <li>두레이 메신저에서 나와의 대화 열기</li>
                      <li>우측 상단 설정 → 봇 추가</li>
                      <li>이름을 정하고 추가하면 나오는 <b>서비스 후크 URL</b> 복사</li>
                      <li>여기에 붙여넣고 [저장 + 테스트]</li>
                    </ol>
                  </details>
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

            {isGithubConnected && !ghAdding ? (
              <div>
                {/* 계정을 2개 이상 쓰는 사람이 있다 — 회사·개인을 나눠 쓰는 경우.
                    커밋은 계정마다 조회해 하나의 주간보고로 합친다. */}
                {ghAccounts.map((a: any, i: number) => (
                  <div key={i} className="bg-background rounded-lg p-4 mb-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-text-primary">
                        {a.username || a.owner || `계정 ${i + 1}`}
                      </span>
                      {ghAccounts.length > 1 && (
                        <button className="text-[11px] text-red-500 hover:underline"
                          disabled={saving === 'github'} onClick={() => removeGhAccount(i)}>삭제</button>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-secondary">토큰</span>
                      <span className="text-xs font-mono text-text-secondary">{a.token}</span>
                    </div>
                    {a.owner && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-text-secondary">Owner</span>
                        <span className="text-xs text-text-secondary">{a.owner}</span>
                      </div>
                    )}
                  </div>
                ))}
                {intState.github.updatedAt && (
                  <p className="text-[11px] text-text-secondary mb-3">
                    최근 수정 {new Date(intState.github.updatedAt).toLocaleString('ko-KR')}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <button className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border-color text-text-secondary hover:border-accent hover:text-accent transition-colors"
                    onClick={() => { setGhOwner(''); setGhToken(''); setGhRepo(''); setGhUsername(''); setGhAdding(true); }}>
                    + 계정 추가
                  </button>
                  <button className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors" disabled={saving === 'github-del'} onClick={deleteGithub}>
                    {saving === 'github-del' ? '해제 중...' : '연동 해제'}
                  </button>
                </div>
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
                  <div className="flex items-center gap-2">
                    <button className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors" disabled={saving === 'github'} onClick={saveGithub}>
                      {saving === 'github' ? '저장 중...' : (ghAdding ? '계정 추가' : '연결')}
                    </button>
                    {ghAdding && (
                      <button className="px-3 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
                        onClick={() => setGhAdding(false)}>취소</button>
                    )}
                  </div>
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

          {/* 피그마 */}
          <div className="bg-card border border-border-color rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-background border border-border-color flex items-center justify-center text-lg">🎨</div>
                <div>
                  <h3 className="text-base font-bold leading-tight">Figma</h3>
                  <p className="text-xs text-text-secondary">디자인 시안 편집 이력</p>
                </div>
              </div>
              {isFigmaConnected
                ? <span className="text-xs font-medium px-2 py-1 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">연결됨</span>
                : <span className="text-xs font-medium px-2 py-1 rounded-full bg-gray-500/10 text-text-secondary border border-border-color">미연결</span>}
            </div>

            {isFigmaConnected ? (
              <div>
                <div className="bg-background rounded-lg p-4 mb-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-text-secondary">토큰</span>
                    <span className="text-xs font-mono text-text-secondary">{intState.figma.token}</span>
                  </div>
                  {intState.figma.handle && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-secondary">계정</span>
                      <span className="text-xs text-text-secondary">{intState.figma.handle}</span>
                    </div>
                  )}
                  {figDday && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-secondary">토큰 만료</span>
                      <span className={`text-xs font-medium ${
                        figDday.days < 0 ? 'text-red-500'
                        : figDday.days <= 7 ? 'text-red-500'
                        : figDday.days <= 30 ? 'text-amber-600' : 'text-text-secondary'}`}>
                        {figDday.days < 0 ? `만료됨 · ${figDday.raw}` : `D-${figDday.days} · ${figDday.raw}`}
                      </span>
                    </div>
                  )}
                </div>
                <button className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors"
                  disabled={saving === 'figma-del'} onClick={deleteFigma}>
                  {saving === 'figma-del' ? '해제 중...' : '연동 해제'}
                </button>

                {/* 작업 파일 — 접어두어 카드가 길어지지 않게 한다 */}
                <div className="mt-3 pt-3 border-t border-border-color">
                  <button onClick={() => setFigOpen(!figOpen)}
                    className="w-full flex items-center justify-between text-sm hover:text-accent transition-colors">
                    <span className="font-medium">작업 파일 {figFiles.length}개</span>
                    <span className="text-xs text-text-secondary">{figOpen ? '접기 ▲' : '펼치기 ▼'}</span>
                  </button>

                  {figOpen && (
                    <div className="mt-3 space-y-2">
                      <div className="flex gap-2">
                        <input type="text" value={figUrls} onChange={(e) => setFigUrls(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFigmaFiles(); } }}
                          placeholder="파일 주소를 붙여넣고 Enter"
                          className="flex-1 px-3 py-2 bg-background border border-border-color rounded-lg text-xs font-mono" />
                        <button className="px-3 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-medium rounded-lg flex-shrink-0"
                          disabled={saving === 'figma-files'} onClick={addFigmaFiles}>
                          {saving === 'figma-files' ? '확인 중...' : '추가'}
                        </button>
                      </div>
                      <div className="text-xs text-text-secondary truncate">
                        {figMsg || 'node-id 는 신경 쓰지 않아도 됩니다'}
                      </div>
                      <div className="max-h-32 overflow-y-auto space-y-1 pr-1">
                        {figFiles.length === 0 ? (
                          <div className="text-xs text-text-secondary py-1">등록된 파일이 없습니다</div>
                        ) : figFiles.map(f => (
                          <div key={f.key} className="flex items-center justify-between bg-background rounded-lg px-3 py-1.5">
                            <span className="text-xs truncate">{f.name}</span>
                            <button className="text-xs text-red-500 hover:underline flex-shrink-0 ml-2"
                              onClick={() => removeFigmaFile(f.key)}>삭제</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input type="password" value={figToken} onChange={(e) => setFigToken(e.target.value)}
                    placeholder="figd_ 로 시작하는 개인 액세스 토큰"
                    className="flex-1 px-3 py-2 bg-background border border-border-color rounded-lg text-sm" />
                  <select value={figDays} onChange={(e) => setFigDays(e.target.value)} title="발급할 때 고른 기간"
                    className="px-2 py-2 bg-background border border-border-color rounded-lg text-sm">
                    <option value="7">7일</option>
                    <option value="30">30일</option>
                    <option value="60">60일</option>
                    <option value="90">90일</option>
                  </select>
                  <button className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg"
                    disabled={saving === 'figma'} onClick={saveFigmaToken}>
                    {saving === 'figma' ? '저장 중...' : '저장'}
                  </button>
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Settings → Security → Personal access tokens<br />
                  권한 <span className="font-mono">current_user:read</span>, <span className="font-mono">file_metadata:read</span>,
                  {' '}<span className="font-mono">file_versions:read</span> · 최대 90일
                </p>
              </div>
            )}
          </div>
        </div>
      )}


      <BusinessReportSection userNN={getUserNN()} />
    </div>
  );
}
