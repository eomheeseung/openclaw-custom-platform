import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Search, MessageSquare, Bot, LayoutDashboard, Users, Calendar, Plug, Workflow, Hash, ArrowRight, X } from 'lucide-react';
import type { Agent, Session, Message } from '../types';

type ViewType = 'dashboard' | 'chat' | 'agents' | 'cron' | 'channels' | 'integrations' | 'workflow';

interface PageOption {
  view: ViewType;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}

const PAGES: PageOption[] = [
  { view: 'dashboard', label: '대시보드',     icon: LayoutDashboard },
  { view: 'chat',      label: '채팅',         icon: MessageSquare },
  { view: 'agents',    label: '에이전트 관리', icon: Users },
  { view: 'workflow',  label: '워크플로',     icon: Workflow },
  { view: 'cron',      label: 'cron 작업',    icon: Calendar },
  { view: 'channels',  label: '채널',         icon: Hash },
  { view: 'integrations', label: '연동',      icon: Plug },
];

type Item =
  | { kind: 'agent'; id: string; label: string; sub?: string; agent: Agent }
  | { kind: 'session'; id: string; label: string; sub?: string; session: Session }
  | { kind: 'message'; id: string; label: string; sub?: string; message: Message }
  | { kind: 'page'; id: string; label: string; sub?: string; page: PageOption };

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  sessions: Session[];
  messages: Message[];
  onSelectAgent: (agent: Agent) => void;
  onSelectSession: (sessionKey: string) => void;
  onNavigate: (view: ViewType) => void;
}

function matchScore(haystack: string, q: string): number {
  if (!q) return 1;
  const h = haystack.toLowerCase();
  const needle = q.toLowerCase();
  if (h.includes(needle)) return 2;
  /* 띄어쓰기 분리 토큰 모두 포함 */
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every(t => h.includes(t))) return 1;
  return 0;
}

export function CommandPalette({
  open,
  onClose,
  agents,
  sessions,
  messages,
  onSelectAgent,
  onSelectSession,
  onNavigate,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* 열릴 때 입력 비우고 포커스 */
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  /* 결과 생성 */
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const q = query.trim();

    /* 에이전트 */
    agents.forEach(a => {
      const score = matchScore(`${a.name} ${a.id} ${a.description || ''}`, q);
      if (score > 0) out.push({ kind: 'agent', id: `agent:${a.id}`, label: a.name, sub: a.description || a.id, agent: a });
    });

    /* 세션 — Sidebar와 동일 필터 룰 적용 */
    const isNoiseLabel = (s: string) =>
      !s
      || /\[Bootstrap pending\]/i.test(s)
      || /Please read BOOTSTRAP\.md/i.test(s)
      || /\[Subagent Context\]/i.test(s)
      || /^\[cron:/i.test(s)
      || /HEARTBEAT/i.test(s)
      || s.includes('untrusted')
      || s.includes('Sender (untrusted')
      || s.startsWith('[파일:');

    sessions
      .filter(s => {
        if (/^agent:[^:]+:main$/.test(s.sessionKey)) return false;
        if (s.sessionKey.includes('subagent')) return false;
        if (/:mention-/.test(s.sessionKey)) return false;
        const label = s.label || '';
        if (isNoiseLabel(label)) return false;
        return true;
      })
      .forEach(s => {
        /* derivedTitle은 raw일 수 있어서 무시. useWebSocket에서 정리된 label만 사용. */
        const title = s.label || s.sessionKey;
        const score = matchScore(`${title} ${s.sessionKey}`, q);
        if (score > 0) {
          const ag = agents.find(a => a.id === s.agentId);
          const subParts: string[] = [];
          if (ag) subParts.push(`${ag.emoji || '🤖'} ${ag.name}`);
          if (s.lastMessageAt) subParts.push(new Date(s.lastMessageAt).toLocaleDateString('ko-KR'));
          out.push({ kind: 'session', id: `session:${s.sessionKey}`, label: title, sub: subParts.join(' · '), session: s });
        }
      });

    /* 메시지 — query 있을 때만 (현재 세션 안의 메시지) */
    if (q.length >= 2) {
      messages.slice(-200).forEach(m => {
        if (!m.content) return;
        const t = m.content.trim();
        if (t.length < 2) return;
        const score = matchScore(t, q);
        if (score > 0) {
          const idx = t.toLowerCase().indexOf(q.toLowerCase());
          let snippet = t;
          if (idx >= 0) {
            const start = Math.max(0, idx - 30);
            const end = Math.min(t.length, idx + q.length + 60);
            snippet = (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
          } else {
            snippet = t.slice(0, 120);
          }
          out.push({
            kind: 'message',
            id: `msg:${m.id}`,
            label: snippet.replace(/\n+/g, ' '),
            sub: `${m.role === 'user' ? '나' : m.role === 'assistant' ? '비서' : '시스템'} · ${m.timestamp.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`,
            message: m,
          });
        }
      });
    }

    /* 페이지 */
    PAGES.forEach(p => {
      const score = matchScore(p.label, q);
      if (score > 0) out.push({ kind: 'page', id: `page:${p.view}`, label: p.label, sub: '페이지 이동', page: p });
    });

    return out.slice(0, 50);
  }, [agents, sessions, messages, query]);

  /* 키보드 네비 */
  const handleKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[activeIdx];
      if (it) runItem(it);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [items, activeIdx]);

  /* activeIdx가 결과 범위 벗어나면 보정 */
  useEffect(() => { if (activeIdx >= items.length) setActiveIdx(0); }, [items, activeIdx]);

  /* 활성 아이템 스크롤 뷰로 */
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const runItem = (it: Item) => {
    if (it.kind === 'agent') {
      onSelectAgent(it.agent);
    } else if (it.kind === 'session') {
      onSelectSession(it.session.sessionKey);
    } else if (it.kind === 'page') {
      onNavigate(it.page.view);
    } else if (it.kind === 'message') {
      /* 같은 세션의 메시지로 추정 — DOM 스크롤 */
      onClose();
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-message-id="${it.message.id}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.classList.add('animate-pulse');
        setTimeout(() => el?.classList.remove('animate-pulse'), 1500);
      }, 50);
      return;
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4 bg-black/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-card rounded-2xl shadow-2xl border border-border-color overflow-hidden flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-color">
          <Search className="w-4 h-4 text-text-secondary" strokeWidth={2.5} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="검색 / 에이전트 / 세션 / 페이지 이동..."
            className="flex-1 bg-transparent border-none outline-none text-text-primary placeholder-text-secondary/50 text-sm"
          />
          <kbd className="text-[10px] font-mono text-text-secondary/60 border border-border-color rounded px-1.5 py-0.5">ESC</kbd>
          <button onClick={onClose} className="text-text-secondary/50 hover:text-text-primary"><X className="w-4 h-4" /></button>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-2">
          {items.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-text-secondary/60">
              {query ? '검색 결과 없음' : '입력해서 검색하거나 ↑↓로 이동, Enter로 선택'}
            </div>
          ) : (
            items.map((it, idx) => {
              const active = idx === activeIdx;
              const Icon =
                it.kind === 'agent' ? Bot
                : it.kind === 'session' ? MessageSquare
                : it.kind === 'message' ? MessageSquare
                : (it as { page: PageOption }).page.icon;
              const groupBadge =
                it.kind === 'agent' ? '에이전트'
                : it.kind === 'session' ? '세션'
                : it.kind === 'message' ? '메시지'
                : '페이지';
              return (
                <button
                  key={it.id}
                  data-idx={idx}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => runItem(it)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                    active ? 'bg-accent/[0.08]' : 'hover:bg-accent/[0.04]'
                  }`}
                >
                  {it.kind === 'agent' && it.agent.emoji ? (
                    <span className="text-lg w-5 text-center">{it.agent.emoji}</span>
                  ) : (
                    <Icon className={`w-4 h-4 flex-shrink-0 ${active ? 'text-accent' : 'text-text-secondary'}`} strokeWidth={2.5} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-primary truncate">{it.label}</div>
                    {it.sub && <div className="text-[11px] text-text-secondary truncate">{it.sub}</div>}
                  </div>
                  <span className="text-[10px] font-mono text-text-secondary/50 uppercase tracking-wider flex-shrink-0">{groupBadge}</span>
                  {active && <ArrowRight className="w-3.5 h-3.5 text-accent flex-shrink-0" strokeWidth={3} />}
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border-color flex items-center justify-between text-[10px] text-text-secondary/60">
          <div className="flex items-center gap-3">
            <span><kbd className="font-mono bg-card border border-border-color rounded px-1">↑</kbd>{' '}<kbd className="font-mono bg-card border border-border-color rounded px-1">↓</kbd> 이동</span>
            <span><kbd className="font-mono bg-card border border-border-color rounded px-1">Enter</kbd> 선택</span>
            <span><kbd className="font-mono bg-card border border-border-color rounded px-1">Esc</kbd> 닫기</span>
          </div>
          <span>{items.length}건</span>
        </div>
      </div>
    </div>
  );
}
