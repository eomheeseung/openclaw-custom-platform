import { useEffect, useState } from 'react';
import { Monitor, Play, Copy, Loader2, CheckCircle, X, RotateCcw } from 'lucide-react';

interface VNCPanelProps {
  token: string;
  onClose: () => void;
}

async function callVncApi(action: 'status' | 'start' | 'restart-chrome', userNN: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/vnc/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userNN }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if ((data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || 'VNC API 오류');
  }
  return data;
}

function slotToStr(slot: number): string {
  return String(slot).padStart(2, '0');
}

function parseUserSlot(token: string): number | null {
  const m = token.match(/user(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n || n < 1 || n > 15) return null;
  return n;
}

function vncPort(slot: number): number {
  return 6080 + (slot - 1);
}

type StepKey = 'check' | 'start' | 'wait' | 'open';
type StepState = 'pending' | 'active' | 'done' | 'skipped' | 'error';

interface Step {
  key: StepKey;
  label: string;
}

const STEPS: Step[] = [
  { key: 'check', label: '현재 상태 확인' },
  { key: 'start', label: 'VNC 서버 시작' },
  { key: 'wait',  label: '웹 연결 대기' },
  { key: 'open',  label: '새 탭에서 열기' },
];

export function VNCPanel({ token, onClose }: VNCPanelProps) {
  const slot = parseUserSlot(token);
  const port = slot !== null ? vncPort(slot) : null;
  const vncUrl = port !== null ? `${window.location.protocol}//${window.location.hostname}:${port}/vnc.html` : '';

  const [steps, setSteps] = useState<Record<StepKey, StepState>>({
    check: 'pending', start: 'pending', wait: 'pending', open: 'pending',
  });
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [chromeRestarting, setChromeRestarting] = useState(false);
  const [chromeAlive, setChromeAlive] = useState<boolean | null>(null);
  const [vncAlive, setVncAlive] = useState<boolean | null>(null);

  const resetSteps = () => setSteps({ check: 'pending', start: 'pending', wait: 'pending', open: 'pending' });
  const patch = (k: StepKey, v: StepState) => setSteps(prev => ({ ...prev, [k]: v }));

  const execCheck = async (): Promise<boolean> => {
    if (slot === null) return false;
    const data = await callVncApi('status', slotToStr(slot));
    const running = (data as { running?: boolean }).running === true;
    const chrome = (data as { chrome?: boolean }).chrome === true;
    setVncAlive(running);
    setChromeAlive(chrome);
    // VNC + Chrome 둘 다 떠있어야 완료된 것으로 간주
    return running && chrome;
  };

  const restartChrome = async () => {
    if (slot === null) return;
    setChromeRestarting(true);
    setErrorMsg('');
    try {
      await callVncApi('restart-chrome', slotToStr(slot));
      // 상태 재확인
      await execCheck();
    } catch (e) {
      setErrorMsg('Chrome 재시작 실패: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setChromeRestarting(false);
    }
  };

  const execStart = async () => {
    if (slot === null) return;
    await callVncApi('start', slotToStr(slot));
  };

  const waitForReady = async (maxTries = 8) => {
    for (let i = 0; i < maxTries; i++) {
      await new Promise(r => setTimeout(r, 800));
      try {
        if (await execCheck()) return true;
      } catch { /* keep trying */ }
    }
    return false;
  };

  const run = async () => {
    if (slot === null) return;
    setBusy(true);
    setErrorMsg('');
    resetSteps();
    try {
      patch('check', 'active');
      const running = await execCheck();
      patch('check', 'done');

      if (running) {
        patch('start', 'skipped');
        patch('wait', 'skipped');
      } else {
        patch('start', 'active');
        await execStart();
        patch('start', 'done');

        patch('wait', 'active');
        const ready = await waitForReady();
        patch('wait', ready ? 'done' : 'error');
        if (!ready) throw new Error('VNC 서버가 준비되지 않았습니다 (timeout).');
      }

      patch('open', 'active');
      window.open(vncUrl, '_blank', 'noopener,noreferrer');
      await new Promise(r => setTimeout(r, 300));
      patch('open', 'done');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    // 모달 열릴 때 현재 상태만 체크 (자동 실행 X)
    if (slot === null) return;
    (async () => {
      try {
        patch('check', 'active');
        const running = await execCheck();
        patch('check', 'done');
        if (running) {
          patch('start', 'skipped');
          patch('wait', 'skipped');
        }
      } catch {
        patch('check', 'pending');
      }
    })();
  }, [slot]);

  const copyUrl = async () => {
    if (!vncUrl) return;
    try {
      await navigator.clipboard.writeText(vncUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const completedSteps = Object.values(steps).filter(s => s === 'done' || s === 'skipped').length;
  const progressPct = Math.round((completedSteps / STEPS.length) * 100);
  const allDone = completedSteps === STEPS.length && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-card border border-border-color rounded-2xl w-[480px] max-w-[90vw] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Monitor className="w-5 h-5 text-accent" />
            <h3 className="text-base font-bold text-text-primary">원격 데스크톱 (VNC)</h3>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X className="w-5 h-5" />
          </button>
        </div>

        {slot === null ? (
          <div className="text-sm text-red-400">사용자 슬롯을 확인할 수 없습니다. (토큰: {token || '없음'})</div>
        ) : (
          <div className="space-y-4">
            <div className="bg-background rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">사용자</span>
                <span className="text-sm font-medium text-text-primary">user{String(slot).padStart(2, '0')}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">접속 주소</span>
                <div className="flex items-center gap-1">
                  <code className="text-xs bg-card px-2 py-0.5 rounded text-accent">{vncUrl}</code>
                  <button onClick={copyUrl} className="p-1 text-text-secondary hover:text-accent" title="복사">
                    {copied ? <CheckCircle className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-text-secondary">진행 상황</span>
                <span className="text-xs text-text-secondary">{progressPct}%</span>
              </div>
              <div className="w-full h-2 bg-background rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${errorMsg ? 'bg-red-500' : allDone ? 'bg-green-500' : 'bg-accent'}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            {/* Step list */}
            <div className="space-y-1.5">
              {STEPS.map(step => {
                const state = steps[step.key];
                return (
                  <div key={step.key} className="flex items-center gap-2 text-sm">
                    {state === 'active' && <Loader2 className="w-4 h-4 animate-spin text-accent" />}
                    {state === 'done' && <CheckCircle className="w-4 h-4 text-green-400" />}
                    {state === 'skipped' && <CheckCircle className="w-4 h-4 text-text-secondary/60" />}
                    {state === 'pending' && <div className="w-4 h-4 rounded-full border border-border-color" />}
                    {state === 'error' && <X className="w-4 h-4 text-red-400" />}
                    <span className={
                      state === 'active' ? 'text-text-primary font-medium' :
                      state === 'done' ? 'text-text-primary' :
                      state === 'skipped' ? 'text-text-secondary' :
                      state === 'error' ? 'text-red-400' :
                      'text-text-secondary/70'
                    }>
                      {step.label}
                      {state === 'skipped' && ' (이미 실행 중)'}
                    </span>
                  </div>
                );
              })}
            </div>

            {errorMsg && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 px-3 py-2 rounded-lg">
                ⚠ {errorMsg}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={run}
                disabled={busy || chromeRestarting}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                {allDone ? '다시 열기' : '원격 데스크톱 열기'}
              </button>
              {vncAlive && !chromeAlive && (
                <button
                  onClick={restartChrome}
                  disabled={chromeRestarting || busy}
                  className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/90 hover:bg-amber-500 text-white rounded-lg text-sm disabled:opacity-60"
                  title="Chrome 프로세스만 재시작 (VNC 유지)"
                >
                  {chromeRestarting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  Chrome 재시작
                </button>
              )}
            </div>
            {vncAlive && !chromeAlive && !errorMsg && (
              <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 px-3 py-2 rounded-lg">
                ⚠ VNC는 떠있지만 Chrome이 죽어있어요. "Chrome 재시작" 버튼으로 복구하거나 VNC 새로고침 후 확인해보세요.
              </div>
            )}

            <p className="text-xs text-text-secondary leading-relaxed">
              로그인이 필요한 사이트를 모니터링하려면, VNC로 접속해서 Chrome에 미리 로그인해 두세요.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
