import { useEffect, useState, useCallback, useMemo } from 'react';
import { Zap, Clock, Mail, Sparkles, Calendar } from 'lucide-react';
import type { Agent, Message } from '../types';

interface BriefHeaderProps {
  agents: Agent[];
  messages: Message[];
  sendRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  slot: string;
  onCreateAgent?: () => void;
  onQuickPrompt?: (text: string) => void;
  /* embedded=true면 wrapping div(padding/border/배경/마진) 제거. chat header 옆에 인라인 흡수용. */
  embedded?: boolean;
}

interface CronSnapshot {
  total: number;
  enabled: number;
  nextRunMs?: number;
  nextRunName?: string;
}

interface BriefSnapshot {
  nextMeeting: { title: string; start: string; location: string; allDay: boolean } | null;
  unread: { today: number | null; week: number | null };
  loaded: boolean;
}

const POLL_CRON_MS = 60_000;
const POLL_BRIEF_MS = 60_000;

function formatRelative(ms?: number): string {
  if (!ms) return '-';
  const diff = ms - Date.now();
  if (diff <= 0) return '곧';
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}분 후`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}시간 후`;
  const d = Math.round(h / 24);
  return `${d}일 후`;
}

function formatMeetingTime(iso: string, allDay: boolean): string {
  if (allDay) return '종일';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return ''; }
}

export function BriefHeader({
  agents,
  messages,
  sendRequest,
  slot,
  onCreateAgent: _onCreateAgent,
  onQuickPrompt,
  embedded = false,
}: BriefHeaderProps) {
  /* agents prop은 activeAgentIds 계산엔 안 쓰지만 호환 위해 받음 */
  void agents;
  void _onCreateAgent;
  const [cron, setCron] = useState<CronSnapshot>({ total: 0, enabled: 0 });
  const [brief, setBrief] = useState<BriefSnapshot>({ nextMeeting: null, unread: { today: null, week: null }, loaded: false });

  /* 활성 에이전트: 마지막 5분 내 멘션된 에이전트 */
  const activeAgentIds = useMemo(() => {
    const cutoff = Date.now() - 5 * 60_000;
    const ids = new Set<string>();
    for (const m of messages) {
      const ts = m.timestamp instanceof Date ? m.timestamp.getTime() : 0;
      if (ts < cutoff) continue;
      if (m.mentionAgentId) ids.add(m.mentionAgentId);
    }
    return ids;
  }, [messages]);

  /* cron 폴링 (WebSocket RPC — 미지원이어도 silent) */
  const refreshCron = useCallback(async () => {
    try {
      const res = await sendRequest('cron.list', {});
      const payload = (res as { payload?: { jobs?: Array<{ enabled?: boolean; name?: string; nextRunAtMs?: number }> } }).payload;
      const jobs = payload?.jobs ?? [];
      const enabled = jobs.filter(j => j.enabled !== false);
      let next: { ms: number; name: string } | undefined;
      for (const j of enabled) {
        const ms = j.nextRunAtMs;
        if (typeof ms === 'number' && ms > Date.now()) {
          if (!next || ms < next.ms) next = { ms, name: j.name || '예약' };
        }
      }
      setCron({ total: jobs.length, enabled: enabled.length, nextRunMs: next?.ms, nextRunName: next?.name });
    } catch { /* silent */ }
  }, [sendRequest]);

  /* /api/brief 폴링 — 다음 미팅 + 미답 메일 한 번에 */
  const refreshBrief = useCallback(async () => {
    try {
      const r = await fetch(`/api/brief?userNN=${encodeURIComponent(slot)}`);
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.ok) {
        setBrief({
          nextMeeting: d.nextMeeting ?? null,
          unread: {
            today: typeof d.unread?.today === 'number' ? d.unread.today : null,
            week: typeof d.unread?.week === 'number' ? d.unread.week : null,
          },
          loaded: true,
        });
      }
    } catch { /* silent */ }
  }, [slot]);

  useEffect(() => {
    refreshCron();
    refreshBrief();
    const t1 = setInterval(refreshCron, POLL_CRON_MS);
    const t2 = setInterval(refreshBrief, POLL_BRIEF_MS);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [refreshCron, refreshBrief]);

  /* embedded면 wrapping styling 제거 — 부모(chat header)가 padding/border 관리 */
  const wrapperCls = embedded
    ? 'flex items-center gap-2 text-xs flex-wrap min-w-0'
    : 'px-6 py-2 flex items-center gap-3 border-b border-border-color bg-gradient-to-r from-accent/[0.02] to-purple-500/[0.02] flex-shrink-0 text-xs flex-wrap';

  return (
    <div className={wrapperCls}>
      {/* 활성 작업 */}
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card border border-border-color">
        <Zap className={`w-3.5 h-3.5 ${activeAgentIds.size > 0 ? 'text-amber-500 animate-pulse' : 'text-text-secondary/40'}`} strokeWidth={2.5} />
        <span className="font-medium text-text-secondary">활성</span>
        <span className={`font-bold ${activeAgentIds.size > 0 ? 'text-amber-600' : 'text-text-secondary/50'}`}>{activeAgentIds.size}</span>
      </div>

      {/* 다음 미팅 */}
      {brief.nextMeeting && (
        <button
          onClick={() => onQuickPrompt?.(`다음 미팅 "${brief.nextMeeting?.title}" 준비할 자료·관련 메일 정리해줘.`)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card border border-border-color hover:border-accent/30 transition-all"
          title="클릭: 비서에게 미팅 준비 요청"
        >
          <Calendar className="w-3.5 h-3.5 text-emerald-600" strokeWidth={2.5} />
          <span className="font-medium text-text-secondary">다음 미팅</span>
          <span className="font-bold text-text-primary">{formatMeetingTime(brief.nextMeeting.start, brief.nextMeeting.allDay)}</span>
          <span className="text-text-secondary/70 truncate max-w-[180px]" title={brief.nextMeeting.title}>· {brief.nextMeeting.title}</span>
        </button>
      )}

      {/* 다음 cron */}
      {cron.nextRunMs ? (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card border border-border-color">
          <Clock className="w-3.5 h-3.5 text-blue-500" strokeWidth={2.5} />
          <span className="font-medium text-text-secondary">다음 예약</span>
          <span className="font-bold text-text-primary">{formatRelative(cron.nextRunMs)}</span>
          {cron.nextRunName && (
            <span className="text-text-secondary/70 truncate max-w-[120px]" title={cron.nextRunName}>· {cron.nextRunName}</span>
          )}
        </div>
      ) : cron.enabled > 0 ? (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card border border-border-color">
          <Clock className="w-3.5 h-3.5 text-text-secondary/50" strokeWidth={2.5} />
          <span className="font-medium text-text-secondary">cron {cron.enabled}개 가동</span>
        </div>
      ) : null}

      {/* 미답 메일 — today / week 두 구간. 광고/소셜/알림 제외, 받은편지함 한정 */}
      {(brief.unread.today !== null || brief.unread.week !== null) && (
        <div
          className="flex items-center gap-0 px-0.5 py-0.5 rounded-full bg-card border border-border-color"
          title="받은편지함 미답 (광고/소셜/알림 제외)"
        >
          <Mail
            className={`w-3.5 h-3.5 ml-2 ${(brief.unread.week ?? 0) > 0 ? 'text-rose-500' : 'text-text-secondary/40'}`}
            strokeWidth={2.5}
          />
          <span className="ml-1.5 font-medium text-text-secondary">미답</span>

          {brief.unread.today !== null && (
            <button
              onClick={() => onQuickPrompt?.('오늘 받은편지함 미답 메일 다 보고, 답장 필요한 것만 요약 + 답장 초안 만들어줘. 광고/뉴스레터/소셜은 제외하고 처리.')}
              className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full hover:bg-rose-50 transition-all"
              title="오늘 미답 → 비서가 요약 + 답장 초안"
            >
              <span className="text-[10px] text-text-secondary/70">오늘</span>
              <span className={`font-bold ${(brief.unread.today ?? 0) > 0 ? 'text-rose-600' : 'text-text-secondary/50'}`}>
                {brief.unread.today}
              </span>
            </button>
          )}

          {brief.unread.week !== null && (
            <button
              onClick={() => onQuickPrompt?.('지난 7일 받은편지함 미답 메일 중 답장 필요한 것 5건만 골라서 우선순위 순으로 요약 + 답장 초안. 광고/뉴스레터/소셜 제외.')}
              className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full hover:bg-rose-50 transition-all mr-1"
              title="최근 7일 미답 → 비서가 5건 추려서 요약 + 답장 초안"
            >
              <span className="text-[10px] text-text-secondary/70">7일</span>
              <span className={`font-bold ${(brief.unread.week ?? 0) > 0 ? 'text-rose-600' : 'text-text-secondary/50'}`}>
                {brief.unread.week}
              </span>
            </button>
          )}
        </div>
      )}

      {/* 강점 어필 — embedded 시 숨김 (공간 절약) */}
      {!embedded && (
        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-text-secondary/60">
          <Sparkles className="w-3 h-3" />
          <span>서브에이전트 오케스트레이션 ON</span>
        </div>
      )}
    </div>
  );
}
