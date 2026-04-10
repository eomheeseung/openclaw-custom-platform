import { useState, useEffect, useCallback } from 'react';
import { Plus, Play, Pencil, Trash2, Save, X, Clock, CheckCircle, XCircle, Pause, RotateCcw, CalendarClock } from 'lucide-react';
import type { ProtocolFrame, Agent } from '../types';

interface CronManagerProps {
  sendRequest: (method: string, params?: Record<string, unknown>) => Promise<ProtocolFrame>;
  agents: Agent[];
}

interface CronJob {
  id: string;
  name: string;
  schedule: string; // normalized cron expression for UI
  text: string;
  agentId?: string;
  enabled: boolean;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  updatedAtMs?: number;
}

interface CronRun {
  id: string;
  jobId: string;
  jobName?: string;
  status: 'ok' | 'error' | 'skipped';
  startedAtMs: number;
  finishedAtMs?: number;
  error?: string;
}

const SCHEDULE_PRESETS = [
  { label: '매일 오전 9시', value: '0 9 * * *', desc: '매일 아침' },
  { label: '매일 오후 6시', value: '0 18 * * *', desc: '매일 저녁' },
  { label: '평일 오전 9시', value: '0 9 * * 1-5', desc: '월~금 아침' },
  { label: '평일 오후 6시', value: '0 18 * * 1-5', desc: '월~금 저녁' },
  { label: '매시간', value: '0 * * * *', desc: '1시간마다' },
  { label: '3시간마다', value: '0 */3 * * *', desc: '3시간 간격' },
  { label: '매주 월요일 오전 9시', value: '0 9 * * 1', desc: '주간 시작' },
  { label: '매주 금요일 오후 5시', value: '0 17 * * 5', desc: '주간 마무리' },
  { label: '매월 1일 오전 9시', value: '0 9 1 * *', desc: '월간' },
];

const DAY_OPTIONS = [
  { label: '월', value: 1 },
  { label: '화', value: 2 },
  { label: '수', value: 3 },
  { label: '목', value: 4 },
  { label: '금', value: 5 },
  { label: '토', value: 6 },
  { label: '일', value: 0 },
];

/** 사용자 선택으로부터 cron 표현식 생성 */
function buildCron(hour: number, minute: number, days: number[], intervalHours?: number): string {
  if (intervalHours && intervalHours > 0) {
    return `${minute} */${intervalHours} * * *`;
  }
  const dowPart = days.length === 0 || days.length === 7 ? '*' : days.join(',');
  return `${minute} ${hour} * * ${dowPart}`;
}

/** cron 표현식을 사람이 읽을 수 있는 한국어로 변환 */
function cronToHuman(cron: string): string {
  const preset = SCHEDULE_PRESETS.find(p => p.value === cron);
  if (preset) return preset.label;

  const parts = cron.split(/\s+/);
  if (parts.length < 5) return cron;

  const [min, hour, dom, , dow] = parts;

  const dowMap: Record<string, string> = {
    '0': '일', '1': '월', '2': '화', '3': '수', '4': '목', '5': '금', '6': '토',
  };

  let timeStr = '';
  if (hour !== '*' && !hour.startsWith('*/') && min !== '*') {
    const h = parseInt(hour);
    const m = parseInt(min);
    const period = h < 12 ? '오전' : '오후';
    const displayH = h > 12 ? h - 12 : h === 0 ? 12 : h;
    timeStr = `${period} ${displayH}시${m > 0 ? ` ${m}분` : ''}`;
  } else if (hour === '*') {
    timeStr = `매시간 ${min}분`;
  } else if (hour.startsWith('*/')) {
    timeStr = `${hour.slice(2)}시간마다`;
  }

  let dayStr = '';
  if (dow === '1-5') {
    dayStr = '평일';
  } else if (dow === '0,6') {
    dayStr = '주말';
  } else if (dow !== '*') {
    const dayNames = dow.split(',').map(d => dowMap[d] || d).join(', ');
    dayStr = `매주 ${dayNames}요일`;
  }
  if (dom !== '*') {
    dayStr = `매월 ${dom}일`;
  }

  if (dayStr && timeStr) return `${dayStr} ${timeStr}`;
  if (timeStr) return `매일 ${timeStr}`;
  return cron;
}

/** cron 표현식에서 시간/분/요일 파싱 */
function parseCron(cron: string): { hour: number; minute: number; days: number[]; intervalHours: number } {
  const parts = cron.split(/\s+/);
  if (parts.length < 5) return { hour: 9, minute: 0, days: [], intervalHours: 0 };

  const [min, hour, , , dow] = parts;

  let intervalHours = 0;
  let h = 9;
  let m = parseInt(min) || 0;

  if (hour.startsWith('*/')) {
    intervalHours = parseInt(hour.slice(2)) || 1;
  } else if (hour !== '*') {
    h = parseInt(hour) || 0;
  }

  let days: number[] = [];
  if (dow !== '*') {
    if (dow === '1-5') {
      days = [1, 2, 3, 4, 5];
    } else if (dow === '0,6') {
      days = [0, 6];
    } else {
      days = dow.split(',').map(d => parseInt(d)).filter(d => !isNaN(d));
    }
  }

  return { hour: h, minute: m, days, intervalHours };
}

type ScheduleMode = 'preset' | 'custom';

/** 스케줄 설정 UI 컴포넌트 */
function SchedulePicker({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const [mode, setMode] = useState<ScheduleMode>(
    SCHEDULE_PRESETS.find(p => p.value === value) ? 'preset' : value ? 'custom' : 'preset'
  );
  const parsed = parseCron(value || '0 9 * * *');
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [days, setDays] = useState<number[]>(parsed.days);
  const [intervalHours, setIntervalHours] = useState(parsed.intervalHours);
  const [useInterval, setUseInterval] = useState(parsed.intervalHours > 0);

  const updateCustom = (h: number, m: number, d: number[], ih: number, isInterval: boolean) => {
    onChange(buildCron(h, m, d, isInterval ? ih : undefined));
  };

  const toggleDay = (day: number) => {
    const next = days.includes(day) ? days.filter(d => d !== day) : [...days, day];
    setDays(next);
    updateCustom(hour, minute, next, intervalHours, useInterval);
  };

  return (
    <div>
      <label className="block text-xs text-text-secondary mb-2">실행 시간</label>

      {/* Mode toggle */}
      <div className="flex gap-1 mb-3 bg-background rounded-lg p-1">
        <button
          onClick={() => setMode('preset')}
          className={`flex-1 px-3 py-1.5 rounded-md text-sm transition-colors ${
            mode === 'preset' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          빠른 선택
        </button>
        <button
          onClick={() => {
            setMode('custom');
            if (!value) updateCustom(hour, minute, days, intervalHours, useInterval);
          }}
          className={`flex-1 px-3 py-1.5 rounded-md text-sm transition-colors ${
            mode === 'custom' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          직접 설정
        </button>
      </div>

      {mode === 'preset' ? (
        <div className="grid grid-cols-3 gap-2">
          {SCHEDULE_PRESETS.map(preset => (
            <button
              key={preset.value}
              onClick={() => onChange(preset.value)}
              className={`px-3 py-2.5 rounded-lg text-sm text-left transition-colors border ${
                value === preset.value
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border-color bg-background text-text-primary hover:border-accent/50'
              }`}
            >
              <span className="block font-medium">{preset.label}</span>
              <span className="block text-xs text-text-secondary mt-0.5">{preset.desc}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4 bg-background rounded-lg p-4">
          {/* 반복 vs 특정 시간 */}
          <div className="flex gap-1 bg-card rounded-lg p-1">
            <button
              onClick={() => {
                setUseInterval(false);
                updateCustom(hour, minute, days, intervalHours, false);
              }}
              className={`flex-1 px-3 py-1.5 rounded-md text-sm transition-colors ${
                !useInterval ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              특정 시간
            </button>
            <button
              onClick={() => {
                setUseInterval(true);
                const ih = intervalHours || 1;
                setIntervalHours(ih);
                updateCustom(hour, minute, days, ih, true);
              }}
              className={`flex-1 px-3 py-1.5 rounded-md text-sm transition-colors ${
                useInterval ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              시간 간격
            </button>
          </div>

          {useInterval ? (
            /* 시간 간격 모드 */
            <div>
              <label className="block text-xs text-text-secondary mb-1">반복 간격</label>
              <div className="flex items-center gap-2">
                <select
                  value={intervalHours}
                  onChange={e => {
                    const ih = parseInt(e.target.value);
                    setIntervalHours(ih);
                    updateCustom(hour, minute, days, ih, true);
                  }}
                  className="px-3 py-2 bg-card border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
                >
                  {[1, 2, 3, 4, 6, 8, 12].map(h => (
                    <option key={h} value={h}>{h}시간</option>
                  ))}
                </select>
                <span className="text-sm text-text-secondary">마다 실행</span>
              </div>
            </div>
          ) : (
            /* 특정 시간 모드 */
            <div>
              <label className="block text-xs text-text-secondary mb-1">실행 시각</label>
              <div className="flex items-center gap-2">
                <select
                  value={hour}
                  onChange={e => {
                    const h = parseInt(e.target.value);
                    setHour(h);
                    updateCustom(h, minute, days, intervalHours, false);
                  }}
                  className="px-3 py-2 bg-card border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
                >
                  {Array.from({ length: 24 }, (_, i) => {
                    const period = i < 12 ? '오전' : '오후';
                    const display = i > 12 ? i - 12 : i === 0 ? 12 : i;
                    return <option key={i} value={i}>{period} {display}시</option>;
                  })}
                </select>
                <select
                  value={minute}
                  onChange={e => {
                    const m = parseInt(e.target.value);
                    setMinute(m);
                    updateCustom(hour, m, days, intervalHours, false);
                  }}
                  className="px-3 py-2 bg-card border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
                >
                  {Array.from({ length: 60 }, (_, m) => (
                    <option key={m} value={m}>{m.toString().padStart(2, '0')}분</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* 요일 선택 */}
          {!useInterval && (
            <div>
              <label className="block text-xs text-text-secondary mb-2">
                반복 요일 <span className="text-text-secondary/60">(선택 안 하면 매일)</span>
              </label>
              <div className="flex gap-1.5">
                {DAY_OPTIONS.map(day => (
                  <button
                    key={day.value}
                    onClick={() => toggleDay(day.value)}
                    className={`w-10 h-10 rounded-lg text-sm font-medium transition-colors ${
                      days.includes(day.value)
                        ? 'bg-accent text-white'
                        : 'bg-card border border-border-color text-text-secondary hover:border-accent/50'
                    }`}
                  >
                    {day.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 미리보기 */}
          {value && (
            <div className="pt-2 border-t border-border-color">
              <p className="text-xs text-accent">
                {cronToHuman(value)}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CronManager({ sendRequest, agents }: CronManagerProps) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingJob, setEditingJob] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create form
  const [newName, setNewName] = useState('');
  const [newSchedule, setNewSchedule] = useState('');
  const [newText, setNewText] = useState('');
  const [newAgentId, setNewAgentId] = useState('');

  // Edit form
  const [editName, setEditName] = useState('');
  const [editSchedule, setEditSchedule] = useState('');
  const [editText, setEditText] = useState('');
  const [editAgentId, setEditAgentId] = useState('');

  const showMessage = (msg: string, isError = false) => {
    if (isError) { setError(msg); setSuccess(''); }
    else { setSuccess(msg); setError(''); }
    setTimeout(() => { setError(''); setSuccess(''); }, 3000);
  };

  const loadJobs = useCallback(async () => {
    try {
      setLoading(true);
      const res = await sendRequest('cron.list', { includeDisabled: true, limit: 100 });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      if (payload?.jobs) {
        const rawJobs = payload.jobs as Array<Record<string, unknown>>;
        setJobs(rawJobs.map(j => {
          const sched = j.schedule as { expr?: string; kind?: string } | string;
          const cronExpr = typeof sched === 'string' ? sched : sched?.expr || '';
          const pl = j.payload as { text?: string } | undefined;
          const state = j.state as { nextRunAtMs?: number; lastRunAtMs?: number } | undefined;
          return {
            id: j.id as string,
            name: j.name as string,
            schedule: cronExpr,
            text: pl?.text || pl?.message as string || (j.text as string) || '',
            agentId: (j.agentId as string) || undefined,
            enabled: j.enabled as boolean,
            nextRunAtMs: state?.nextRunAtMs || (j.nextRunAtMs as number | undefined),
            lastRunAtMs: state?.lastRunAtMs || (j.lastRunAtMs as number | undefined),
            updatedAtMs: j.updatedAtMs as number | undefined,
          };
        }));
      }
    } catch {
      showMessage('예약 작업 목록을 불러올 수 없습니다', true);
    } finally {
      setLoading(false);
    }
  }, [sendRequest]);

  const loadRuns = useCallback(async () => {
    try {
      const res = await sendRequest('cron.runs', { scope: 'all', limit: 30, sortDir: 'desc' });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      if (payload?.entries) {
        setRuns(payload.entries as CronRun[]);
      }
    } catch {
      showMessage('실행 이력을 불러올 수 없습니다', true);
    }
  }, [sendRequest]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  const handleCreate = async () => {
    if (!newName.trim() || !newSchedule.trim() || !newText.trim()) {
      showMessage('모든 항목을 입력해주세요', true);
      return;
    }
    try {
      const isDefault = !newAgentId || newAgentId === agents.find(a => a.id === agents[0]?.id)?.id;
      const defaultAgentId = agents[0]?.id;
      const params: Record<string, unknown> = {
        name: newName.trim(),
        schedule: { cron: newSchedule.trim() },
      };
      params.sessionTarget = 'isolated';
      if (newAgentId && newAgentId !== defaultAgentId) {
        params.agentId = newAgentId;
        params.payload = { kind: 'agentTurn', message: newText.trim() };
      } else {
        params.payload = { kind: 'agentTurn', message: newText.trim() };
      }
      await sendRequest('cron.add', params);
      showMessage(`"${newName}" 예약 작업이 생성되었습니다`);
      setShowCreate(false);
      setNewName(''); setNewSchedule(''); setNewText(''); setNewAgentId('');
      loadJobs();
    } catch {
      showMessage('예약 작업 생성에 실패했습니다', true);
    }
  };

  const handleUpdate = async (jobId: string) => {
    try {
      const patch: Record<string, unknown> = {};
      if (editName.trim()) patch.name = editName.trim();
      if (editSchedule.trim()) patch.schedule = { cron: editSchedule.trim() };
      if (editText.trim()) patch.text = editText.trim();

      await sendRequest('cron.update', { id: jobId, patch });
      showMessage('예약 작업이 수정되었습니다');
      setEditingJob(null);
      loadJobs();
    } catch {
      showMessage('예약 작업 수정에 실패했습니다', true);
    }
  };

  const handleDelete = async (job: CronJob) => {
    if (!confirm(`"${job.name}" 예약 작업을 삭제하시겠습니까?`)) return;
    try {
      await sendRequest('cron.remove', { id: job.id });
      showMessage(`"${job.name}" 예약 작업이 삭제되었습니다`);
      loadJobs();
    } catch {
      showMessage('예약 작업 삭제에 실패했습니다', true);
    }
  };

  const handleToggle = async (job: CronJob) => {
    try {
      await sendRequest('cron.update', { id: job.id, patch: { enabled: !job.enabled } });
      showMessage(job.enabled ? '예약 작업이 비활성화되었습니다' : '예약 작업이 활성화되었습니다');
      loadJobs();
    } catch {
      showMessage('상태 변경에 실패했습니다', true);
    }
  };

  const handleRun = async (job: CronJob) => {
    try {
      await sendRequest('cron.run', { id: job.id, mode: 'force' });
      showMessage(`"${job.name}" 작업을 수동 실행했습니다`);
    } catch {
      showMessage('수동 실행에 실패했습니다', true);
    }
  };

  const startEdit = (job: CronJob) => {
    setEditingJob(job.id);
    setEditName(job.name);
    setEditSchedule(job.schedule);
    setEditText(job.text);
    setEditAgentId(job.agentId || '');
  };

  const formatTime = (ms?: number) => {
    if (!ms) return '-';
    return new Date(ms).toLocaleString('ko-KR', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-text-secondary">불러오는 중...</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-text-primary">예약 작업</h2>
          <button
            onClick={() => { setShowRuns(!showRuns); if (!showRuns) loadRuns(); }}
            className="text-xs px-3 py-1 bg-background border border-border-color rounded-lg text-text-secondary hover:text-text-primary transition-colors"
          >
            {showRuns ? '작업 목록' : '실행 이력'}
          </button>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm transition-colors"
        >
          <Plus className="w-4 h-4" />
          새 예약 작업
        </button>
      </div>

      {error && <div className="px-4 py-2 bg-red-500/20 text-red-400 rounded-lg text-sm">{error}</div>}
      {success && <div className="px-4 py-2 bg-green-500/20 text-green-400 rounded-lg text-sm">{success}</div>}

      {/* Create Form */}
      {showCreate && (
        <div className="bg-card border border-border-color rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <CalendarClock className="w-5 h-5 text-accent" />
            <h3 className="text-sm font-medium text-text-primary">새 예약 작업 만들기</h3>
          </div>
          <p className="text-xs text-text-secondary -mt-2">
            정해진 시간에 봇이 자동으로 작업을 수행합니다.
          </p>

          <div>
            <label className="block text-xs text-text-secondary mb-1">작업 이름</label>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="예: 일일 업무 리포트, 주간 코드 점검"
              className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
            />
          </div>

          {agents.length > 0 && (
            <div>
              <label className="block text-xs text-text-secondary mb-2">실행할 봇</label>
              <div className="flex gap-2">
                {agents.map(agent => (
                  <button
                    key={agent.id}
                    onClick={() => setNewAgentId(agent.id)}
                    className={`px-3 py-2 rounded-lg text-sm transition-colors border ${
                      (newAgentId || agents[0]?.id) === agent.id
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border-color bg-background text-text-primary hover:border-accent/50'
                    }`}
                  >
                    {agent.emoji || '🤖'} {agent.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <SchedulePicker value={newSchedule} onChange={setNewSchedule} />

          <div>
            <label className="block text-xs text-text-secondary mb-1">봇에게 보낼 메시지</label>
            <textarea
              value={newText}
              onChange={e => setNewText(e.target.value)}
              placeholder="예: 오늘 진행된 작업을 정리해서 리포트를 작성해줘"
              rows={3}
              className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm resize-none focus:outline-none focus:border-accent"
            />
            <p className="text-xs text-text-secondary mt-1">
              이 메시지가 설정한 시간에 자동으로 봇에게 전송됩니다.
            </p>
          </div>

          <div className="flex gap-2 pt-1">
            <button onClick={handleCreate} className="flex items-center gap-1 px-4 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent-hover">
              <Save className="w-3 h-3" /> 생성
            </button>
            <button onClick={() => { setShowCreate(false); setNewName(''); setNewSchedule(''); setNewText(''); }} className="px-4 py-2 text-text-secondary hover:text-text-primary text-sm">
              취소
            </button>
          </div>
        </div>
      )}

      {/* Run History */}
      {showRuns ? (
        <div className="space-y-2">
          {runs.length === 0 ? (
            <p className="text-text-secondary text-sm text-center py-8">실행 이력이 없습니다</p>
          ) : (
            <>
              <div className="flex justify-end mb-2">
                <button
                  onClick={async () => {
                    if (!confirm('모든 실행 이력을 삭제하시겠습니까?')) return;
                    try {
                      // 서버의 runs 파일 직접 삭제 (exec tool 사용)
                      await sendRequest('tools.invoke' as string, { tool: 'exec', args: { command: 'rm -f /home/node/.openclaw/cron/runs/*.jsonl' } }).catch(() => {});
                      // 로컬 상태 초기화
                      setRuns([]);
                      showMessage('실행 이력이 삭제되었습니다');
                    } catch { showMessage('삭제 실패', true); }
                  }}
                  className="text-xs px-3 py-1.5 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                >
                  전체 삭제
                </button>
              </div>
              {runs.map((run, idx) => {
                // jobId로 작업 이름 찾기
                const job = jobs.find(j => j.id === run.jobId);
                const displayName = run.jobName || job?.name || run.jobId;
                const agent = job?.agentId ? agents.find(a => a.id === job.agentId) : null;
                const duration = run.finishedAtMs && run.startedAtMs
                  ? ((run.finishedAtMs - run.startedAtMs) / 1000).toFixed(1) + '초'
                  : '';

                return (
                  <div key={run.id || idx} className="bg-card border border-border-color rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        {run.status === 'ok' ? (
                          <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                        ) : run.status === 'error' ? (
                          <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                        ) : (
                          <Pause className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-text-primary truncate">{displayName}</p>
                            {agent && (
                              <span className="text-xs px-1.5 py-0.5 bg-accent/10 text-accent rounded flex-shrink-0">
                                {agent.emoji || '🤖'} {agent.name}
                              </span>
                            )}
                            <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${
                              run.status === 'ok' ? 'bg-green-500/10 text-green-400' :
                              run.status === 'error' ? 'bg-red-500/10 text-red-400' :
                              'bg-yellow-500/10 text-yellow-400'
                            }`}>
                              {run.status === 'ok' ? '성공' : run.status === 'error' ? '오류' : '건너뜀'}
                            </span>
                          </div>
                          {run.error && <p className="text-xs text-red-400 mt-0.5 truncate">{run.error}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                        {duration && <span className="text-xs text-text-secondary">{duration}</span>}
                        <span className="text-xs text-text-secondary">{formatTime(run.startedAtMs)}</span>
                        <button
                          onClick={async () => {
                            try {
                              await sendRequest('tools.invoke' as string, { tool: 'exec', args: { command: `rm -f /home/node/.openclaw/cron/runs/${run.id}.jsonl` } }).catch(() => {});
                              setRuns(prev => prev.filter(r => r.id !== run.id));
                              showMessage('이력이 삭제되었습니다');
                            } catch { showMessage('삭제 실패', true); }
                          }}
                          className="p-1 text-text-secondary hover:text-red-400 rounded transition-colors"
                          title="이력 삭제"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      ) : (
        /* Job List */
        <div className="space-y-3">
          {jobs.length === 0 && !showCreate ? (
            <div className="text-center py-12">
              <CalendarClock className="w-12 h-12 text-text-secondary mx-auto mb-3 opacity-50" />
              <p className="text-text-secondary text-sm">예약 작업이 없습니다</p>
              <p className="text-text-secondary text-xs mt-1">
                정해진 시간에 봇이 자동으로 작업하도록 예약할 수 있습니다.
              </p>
              <button
                onClick={() => setShowCreate(true)}
                className="mt-4 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm transition-colors"
              >
                첫 예약 작업 만들기
              </button>
            </div>
          ) : (
            jobs.map(job => (
              <div key={job.id} className="bg-card border border-border-color rounded-xl overflow-hidden cursor-pointer" onClick={() => { if (editingJob !== job.id) setExpandedJob(expandedJob === job.id ? null : job.id); }}>
                {editingJob === job.id ? (
                  <div className="p-4 space-y-3">
                    <div>
                      <label className="block text-xs text-text-secondary mb-1">작업 이름</label>
                      <input
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
                      />
                    </div>
                    <SchedulePicker value={editSchedule} onChange={setEditSchedule} />
                    <div>
                      <label className="block text-xs text-text-secondary mb-1">봇에게 보낼 메시지</label>
                      <textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        rows={3}
                        className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm resize-none focus:outline-none focus:border-accent"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => handleUpdate(job.id)} className="flex items-center gap-1 px-3 py-1.5 bg-accent text-white rounded-lg text-sm hover:bg-accent-hover">
                        <Save className="w-3 h-3" /> 저장
                      </button>
                      <button onClick={() => setEditingJob(null)} className="px-3 py-1.5 text-text-secondary hover:text-text-primary text-sm">
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${job.enabled ? 'bg-green-400' : 'bg-gray-500'}`} />
                          <p className="font-medium text-text-primary">{job.name}</p>
                          {job.agentId && (() => {
                            const agent = agents.find(a => a.id === job.agentId);
                            return (
                              <span className="text-xs px-1.5 py-0.5 bg-accent/10 text-accent rounded">
                                {agent?.emoji || '🤖'} {agent?.name || job.agentId}
                              </span>
                            );
                          })()}
                          {!job.enabled && (
                            <span className="text-xs px-1.5 py-0.5 bg-gray-500/20 text-gray-400 rounded">비활성</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <Clock className="w-3 h-3 text-text-secondary" />
                          <span className="text-xs text-text-secondary">{cronToHuman(job.schedule)}</span>
                        </div>
                        <p className="text-sm text-text-secondary mt-2 line-clamp-2">{job.text}</p>
                        {job.nextRunAtMs && (
                          <p className="text-xs text-accent/70 mt-1">
                            다음 실행: {formatTime(job.nextRunAtMs)}
                          </p>
                        )}
                      </div>
                      {expandedJob === job.id && (
                        <div className="flex items-center gap-1 ml-3" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleRun(job)}
                            className="p-2 text-text-secondary hover:text-green-400 hover:bg-background rounded-lg transition-colors"
                            title="지금 바로 실행"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleToggle(job)}
                            className="p-2 text-text-secondary hover:text-yellow-400 hover:bg-background rounded-lg transition-colors"
                            title={job.enabled ? '비활성화' : '활성화'}
                          >
                            {job.enabled ? <Pause className="w-4 h-4" /> : <RotateCcw className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => { startEdit(job); setExpandedJob(null); }}
                            className="p-2 text-text-secondary hover:text-accent hover:bg-background rounded-lg transition-colors"
                            title="수정"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(job)}
                            className="p-2 text-text-secondary hover:text-red-400 hover:bg-background rounded-lg transition-colors"
                            title="삭제"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
