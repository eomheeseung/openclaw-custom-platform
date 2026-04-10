import { useState, useEffect, useCallback } from 'react';

function getUserNN(): string {
  return (new URLSearchParams(window.location.search).get('token') || '').replace(/\D/g, '') || '01';
}

export function IntegrationsPage() {
  const [intState, setIntState] = useState<any>({ dooray: null, github: null, loading: true });
  const [doorayToken, setDoorayToken] = useState('');
  const [ghOwner, setGhOwner] = useState('');
  const [ghToken, setGhToken] = useState('');
  const [ghRepo, setGhRepo] = useState('');
  const [saving, setSaving] = useState('');

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
        body: JSON.stringify({ github: { owner: ghOwner.trim(), token: ghToken.trim(), repo: ghRepo.trim() }, userNN: getUserNN() }),
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
        body: JSON.stringify({ github: { owner: '', token: '', repo: '', updatedAt: '' }, userNN: getUserNN() }),
      });
      const d = await r.json();
      if (d.ok) await loadInt(); else alert('실패: ' + (d.error || ''));
    } catch (err: any) { alert('오류: ' + err.message); } finally { setSaving(''); }
  };

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
                    <label className="text-xs font-medium text-text-secondary block mb-1">Owner / Organization</label>
                    <input type="text" value={ghOwner} onChange={(e) => setGhOwner(e.target.value)} placeholder="예: tideflo"
                      className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-text-secondary block mb-1">Personal Access Token</label>
                    <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder="ghp_xxxxxxxxxxxx"
                      className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-text-secondary block mb-1">Repository (선택)</label>
                    <input type="text" value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} placeholder="특정 저장소만 연동할 경우"
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
    </div>
  );
}
