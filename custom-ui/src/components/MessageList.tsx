import { useRef, useEffect, useState, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { User, Bot, Loader2, Copy, Download, Check, CheckCircle2, Building2, AlertTriangle } from 'lucide-react';
import type { Message, Agent } from '../types';
import { shouldHideMessage, cleanDisplayContent, stripUserWrapper } from '../utils/messageFilter';
import { SrTableCard, WeekPickerCard, GroupingEditorCard, DraftCard, DownloadCard, parseSrBaseline, parseGroupingConfirm, type SrBaselineItem, type ConfirmedGroup } from './MessageCards';
import { WorkDraftCard, ToolPickCard } from './WorkReportCards';

/* 사용자 메시지에서 [파일: xxx] 라벨 다음의 inline 텍스트를 라벨만 남기고 제거 */
function trimFileContent(content: string): string {
  if (!content || !content.includes('[파일:')) return content;
  return content.replace(/(\[파일:\s*[^\]]+\])\n[\s\S]*?(?=\n*\[파일:|$)/g, '$1');
}

/* cron 실행 메시지에서 [cron:...] 프리픽스와 Current time 라인을 제거 */
function stripCronPrefix(content: string): string {
  if (!content) return content;
  let out = content.replace(/^\[cron:[^\]]*\]\s*/, '');
  out = out.replace(/^Current time:[^\n]*\n?/gm, '');
  return out.replace(/^\n+/, '').trimEnd();
}

/* 래퍼 제거는 messageFilter.stripUserWrapper 로 단일화 (숨김 판정과 같은 로직을 써야
   "필터는 통과했는데 화면엔 래퍼가 보이는" 불일치가 안 생긴다) */
const stripBootstrapPending = stripUserWrapper;

function ElapsedTimer({ startTime }: { startTime: Date }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(Math.floor((Date.now() - startTime.getTime()) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);
  return <>{elapsed}초</>;
}

/* Copy to clipboard with HTTP fallback */
function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
    } else {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }
  }, []);
  return { copied, copy };
}

interface MessageListProps {
  messages: Message[];
  agents?: Agent[];
  onSendMessage?: (text: string) => void;
  onPrefill?: (text: string) => void;
  /* 프론트 처리 인텐트 (biz-picker intent 매칭). 값 있으면 onSendMessage 스킵. */
  onIntentPick?: (intent: string, project: BizPickerProject) => void;
}

interface BizPickerProject {
  id: string;
  name: string;
  org?: string;
  auth_ok?: boolean;
  archived?: boolean;
  last_used?: string;
  note?: string;
}

interface BizPickerData {
  prompt?: string;
  intent?: string;
  projects: BizPickerProject[];
  hint?: string;
}

/* 프론트 처리 인텐트 목록 (biz-picker.intent 이 이 중 하나면 onSelect(LLM 전송) 스킵하고 onIntentPick 호출) */
const FRONTEND_BIZ_INTENTS = new Set(['last-week-file']);

const BizPickerCard = memo(function BizPickerCard({
  raw,
  onSelect,
  onIntentPick,
}: {
  raw: string;
  onSelect?: (text: string) => void;
  onIntentPick?: (intent: string, project: BizPickerProject) => void;
}) {
  let data: BizPickerData | null = null;
  try { data = JSON.parse(raw); } catch { /* invalid JSON */ }
  if (!data || !Array.isArray(data.projects) || data.projects.length === 0) {
    /* 스트리밍 중 partial일 가능성 → 조용히 로딩 표시 */
    if (!raw.trim().endsWith('}')) {
      return (
        <div className="my-2 p-3 rounded-lg border border-border-color bg-background text-xs text-text-secondary italic">
          biz-picker 카드 로딩 중...
        </div>
      );
    }
    return (
      <div className="my-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-500 font-mono">
        biz-picker: 데이터 파싱 실패 또는 사업 없음
      </div>
    );
  }
  const pick = (p: BizPickerProject) => {
    /* 프론트 처리 인텐트면 LLM 전송 스킵 */
    if (data!.intent && FRONTEND_BIZ_INTENTS.has(data!.intent) && onIntentPick) {
      onIntentPick(data!.intent, p);
      return;
    }
    if (!onSelect) return;
    const intent = data!.intent ? ` (${data!.intent})` : '';
    onSelect(`${p.name} 사업으로 진행해${intent}`);
  };

  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-gradient-to-br from-accent/[0.04] to-purple-500/[0.04] p-4 max-w-2xl">
      <div className="flex items-start gap-2 mb-3">
        <Building2 className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" />
        <div className="text-sm font-bold text-text-primary">
          {data.prompt || '어느 사업 주간보고를 만들까요?'}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {data.projects.map((p) => {
          const disabled = !!p.archived;
          return (
            <button
              key={p.id}
              onClick={() => !disabled && pick(p)}
              disabled={disabled}
              className={`text-left flex gap-3 items-center rounded-xl border px-3 py-2.5 transition-all ${
                disabled
                  ? 'border-border-color bg-background opacity-50 cursor-not-allowed'
                  : 'border-accent/40 bg-white hover:border-accent hover:shadow-md'
              }`}
            >
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent/10 to-purple-500/10 flex items-center justify-center flex-shrink-0">
                <Building2 className="w-4 h-4 text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-text-primary truncate">{p.name}</div>
                <div className="text-xs text-text-secondary mt-0.5 flex items-center gap-1.5 flex-wrap">
                  {p.org && <span>{p.org}</span>}
                  {p.last_used && <span>· 마지막 사용: {p.last_used}</span>}
                  {p.archived && <span>· 아카이브</span>}
                  {p.auth_ok === false && (
                    <span className="inline-flex items-center gap-0.5 text-amber-600 font-semibold">
                      <AlertTriangle className="w-3 h-3" />
                      SR 인증 필요
                    </span>
                  )}
                  {p.note && <span>· {p.note}</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {data.hint && (
        <div className="text-xs text-text-secondary mt-3 pt-3 border-t border-border-color/50">
          {data.hint}
        </div>
      )}
    </div>
  );
});

/* draft-card 검증 기준: 그 카드보다 앞에 있는 가장 가까운 sr-table.
   "가장 가까운" 이어야 여러 주차를 한 세션에서 만들어도 해당 라운드 것과 대조됨.
   못 찾으면 null → 검증 생략 (컨텍스트 압축으로 잘렸거나 sr-table 없는 흐름) */
/* 서브에이전트가 내는 카드 묶음: [{"kind":"sr-table","data":{…}}, …] (단일 객체도 허용).
   kind 가 우리가 아는 카드가 아니면 null 을 돌려 평범한 코드블록으로 남긴다. */
const CARD_FENCE_STARTS = ['```work-draft', '```biz-picker', '```sr-table', '```week-picker',
  '```grouping-editor', '```draft-card', '```download-card', '```tool-pick', '```json'];

const KIND_CARDS = new Set([
  'biz-picker', 'sr-table', 'week-picker', 'grouping-editor',
  'draft-card', 'download-card', 'work-draft', 'tool-pick',
]);

/* 모델이 ```work-draft 를 문장 뒤에 줄바꿈 없이 붙이는 회차가 있다(실측).
   마크다운은 펜스가 줄 처음에 있어야 코드블록으로 보므로, 그대로 두면 JSON 이 글자로 쏟아진다.
   본문 어디에 있든 펜스를 찾아 카드로 만든다. 닫는 펜스가 없어도(출력이 잘려도) 살린다. */
const FENCE_RE = new RegExp(
  '```(' + [...KIND_CARDS].join('|') + ')\\s*([\\s\\S]*?)(?:```|$)', 'g');

function extractFencedCards(raw: string): Array<{ kind: string; data: unknown }> | null {
  const out: Array<{ kind: string; data: unknown }> = [];
  for (const m of raw.matchAll(FENCE_RE)) {
    const body = (m[2] || '').trim();
    if (!body) continue;
    try {
      out.push({ kind: m[1], data: JSON.parse(body) });
    } catch {
      /* 잘린 JSON 은 버린다 — 반쯤 그린 카드보다 원문이 낫다 */
    }
  }
  return out.length ? out : null;
}

/** 본문에서 카드를 찾는다: 전체가 카드 묶음이거나, 문장 사이에 펜스로 들어 있거나. */
function findCards(raw: string): Array<{ kind: string; data: unknown }> | null {
  return parseKindCards(raw) || extractFencedCards(raw);
}

function parseKindCards(raw: string): Array<{ kind: string; data: unknown }> | null {
  try {
    /* ```json 펜스가 붙어 오기도, 맨 JSON 으로 오기도 한다(실측 둘 다) */
    const body = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(body);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    if (!arr.length) return null;
    const cards = arr.filter((x): x is { kind: string; data: unknown } =>
      !!x && typeof x === 'object' && typeof x.kind === 'string' && 'data' in x && KIND_CARDS.has(x.kind));
    return cards.length === arr.length ? cards : null;
  } catch {
    return null;
  }
}

function findSrBaselineBefore(msgs: Message[], idx: number): SrBaselineItem[] | null {
  for (let i = idx - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const fence = m.content.lastIndexOf('```sr-table');
    if (fence === -1) continue;
    const body = m.content.slice(fence + '```sr-table'.length);
    const end = body.indexOf('```');
    return parseSrBaseline((end === -1 ? body : body.slice(0, end)).trim());
  }
  return null;
}

/* draft-card 앞의 가장 가까운 "그룹핑 확정" 사용자 메시지.
   GroupingEditorCard.confirm() 이 보낸 【확정된 그룹】 블록을 파싱해서
   work_items 작업완료 행의 sr_no 표시 + 그룹 통째 누락 검증에 씀.
   ⚠ 조립 형식은 MessageCards 의 GroupingEditorCard.confirm() 에 있음 — 같이 고칠 것 */
function findGroupingConfirmBefore(msgs: Message[], idx: number): ConfirmedGroup[] | null {
  for (let i = idx - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    if (!m.content.includes('【확정된 그룹】')) continue;
    return parseGroupingConfirm(m.content);
  }
  return null;
}

export function MessageList({ messages, agents = [], onSendMessage, onPrefill, onIntentPick }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (scrollRef.current && isAtBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const renderToolCall = (tool: { id: string; name: string; status: string; args?: string; result?: string; duration?: number }) => {
    const isDone = tool.status === 'completed';
    const isError = tool.status === 'error';
    const isRunning = !isDone && !isError;

    return (
      <div key={tool.id} className="my-4 max-w-2xl mx-auto">
        <div className="bg-accent/[0.03] border border-accent/10 rounded-2xl p-5 relative overflow-hidden">
          {/* Top glow line */}
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />

          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3 font-mono text-base font-bold text-accent">
              {isDone ? (
                <Check className="w-5 h-5 text-accent" strokeWidth={3} />
              ) : isError ? (
                <div className="w-5 h-5 rounded-full bg-red-500" />
              ) : (
                <div className="w-5 h-5 border-2 border-accent/20 border-t-accent rounded-full animate-spin" />
              )}
              <span>📋 {tool.name}</span>
            </div>
            <span className="font-mono text-sm text-text-secondary">
              {isDone ? `완료${tool.duration ? ` · ${(tool.duration / 1000).toFixed(1) === '0.0' ? `${tool.duration}ms` : `${(tool.duration / 1000).toFixed(1)}s`}` : ''}` : isError ? '오류' : '실행 중...'}
            </span>
          </div>

          {/* Body (args preview) */}
          {tool.args && (
            <div className="font-mono text-sm text-text-secondary leading-relaxed p-3.5 bg-white/70 border border-black/[0.04] rounded-xl mb-3">
              {tool.args.length > 300 ? tool.args.slice(0, 300) + '...' : tool.args}
            </div>
          )}

          {/* Progress bar */}
          <div className="h-[3px] bg-accent/10 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-1000 ${isDone ? 'w-full bg-accent' : isError ? 'w-full bg-red-400' : 'bg-accent animate-pulse'}`}
              style={isRunning ? { width: '70%' } : {}}
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto scrollbar-thin px-6 py-5 space-y-5"
      style={{ overflowAnchor: 'none' }}
    >
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-text-secondary">
          <Bot className="w-16 h-16 mb-4 opacity-30" />
          <p className="text-lg font-medium">TideClaw에 오신 것을 환영합니다</p>
          <p className="text-sm mt-2 opacity-60">메시지를 입력하여 대화를 시작하세요</p>
        </div>
      ) : (
        (() => {
          const filtered = messages.filter(m => {
            // 로딩 중 비어있는 assistant는 통과시켜 "응답을 작성하고 있습니다" 표시
            if (m.role === 'assistant' && m.isLoading && (!m.content || m.content.trim().length === 0)) return true;
            // working/working- system + toolCalls 있는 system은 통과 (별도 렌더)
            if (m.role === 'system' && m.id.startsWith('working-')) return true;
            /* 도구 호출 카드는 감춘다 — 명령 원문이 화면을 가득 채우고,
               사용자가 볼 이유도 없다. 진행 상황은 '응답 생성 중' 표시로 충분하다. */
            if (m.id.startsWith('toolcall-')) return false;
            return !shouldHideMessage(m.role, m.content || '');
          });
          /* 마지막 user 메시지 이후 assistant 응답이 아직 없는지 — "비서 생각 중" 카드 결정용 */
          const lastIdx = filtered.length - 1;
          const lastMsg = filtered[lastIdx];
          const showAssistantThinking =
            lastMsg && lastMsg.role === 'user' && !lastMsg.isLoading;
          return [
            ...filtered.map((message, idx) => {
          /* 카드에서 시작한 대화는 그 에이전트로 이어간다.
             카드 클릭 응답이 비서에게 가면 비서가 다시 위임하느라 한 단계를 더 거치고,
             중간에서 내용을 재작성할 위험도 남는다(실측: 위임 결과를 자기 말로 다시 씀). */
          const sendKeepingAgent = (text: string) => {
            const agentId = message.mentionAgentId;
            onSendMessage?.(agentId && !text.trimStart().startsWith('@') ? `@${agentId} ${text}` : text);
          };

          /* 같은 종류 카드가 여러 번 나오면(초안 생성 직후 + 다듬기 후) 마지막 것만 보여준다.
             둘 다 보이면 다듬기 전 문구가 함께 남아 헷갈린다. */
          const cardKindsHere = new Set(
            (findCards(cleanDisplayContent(message.content || '')) || []).map(c => c.kind));
          const supersededKinds = new Set<string>();
          if (cardKindsHere.size) {
            for (let k = idx + 1; k < filtered.length; k++) {
              const later = findCards(cleanDisplayContent(filtered[k].content || '')) || [];
              for (const c of later) if (cardKindsHere.has(c.kind)) supersededKinds.add(c.kind);
            }
          }

          const renderKindCardTop = (kind: string, data: string, mid: string, i: number) => {
            if (supersededKinds.has(kind)) return null;   // 뒤에 같은 카드가 또 있으면 이건 옛 것
            if (kind === 'biz-picker')      return <BizPickerCard raw={data} onSelect={sendKeepingAgent} onIntentPick={onIntentPick} />;
            if (kind === 'sr-table')         return <SrTableCard raw={data} />;
            if (kind === 'week-picker')      return <WeekPickerCard raw={data} onSelect={sendKeepingAgent} />;
            if (kind === 'grouping-editor')  return <GroupingEditorCard raw={data} onSelect={sendKeepingAgent} messageId={`${mid}-${i}`} />;
            if (kind === 'draft-card')       return <DraftCard raw={data} onSelect={sendKeepingAgent} onPrefill={onPrefill} srBaseline={findSrBaselineBefore(filtered, idx)} confirmedGroups={findGroupingConfirmBefore(filtered, idx)} />;
            if (kind === 'download-card')    return <DownloadCard raw={data} onSelect={sendKeepingAgent} />;
            if (kind === 'work-draft')       return <WorkDraftCard raw={data} onSelect={sendKeepingAgent} />;
            if (kind === 'tool-pick')        return <ToolPickCard raw={data} onSelect={sendKeepingAgent} />;
            return null;
          };
          const isUser = message.role === 'user';
          const isSystem = message.role === 'system';

          // System messages with tool calls → render as tool card
          if (isSystem && message.toolCalls && message.toolCalls.length > 0) {
            return (
              <div key={message.id}>
                {message.toolCalls.map(tool => renderToolCall(tool))}
              </div>
            );
          }

          // Working card (별도 작업 중 표시)
          if (isSystem && message.id.startsWith('working-')) {
            return (
              <div key={message.id} className="flex justify-center my-3">
                <div className="inline-flex items-center gap-3 px-6 py-3.5 rounded-2xl text-sm font-semibold bg-amber-500/10 border-2 border-amber-500/30 text-amber-800 shadow-md shadow-amber-500/10">
                  <Loader2 className="w-5 h-5 animate-spin text-amber-600" strokeWidth={2.5} />
                  <span>{message.content}</span>
                  <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-amber-500/25 text-amber-900">
                    <ElapsedTimer startTime={message.timestamp} />
                  </span>
                </div>
              </div>
            );
          }

          // Delegation badge — 위임 표시 + 응답 도착 여부에 따라 spinner/완료 표시
          if (isSystem) {
            /* 위임 system 다음에 isMention assistant 응답이 도착했는지 확인 */
            const pending = !filtered.slice(idx + 1).some(m =>
              m.role === 'assistant' && !!m.mentionAgentId && (m.content || '').trim().length > 0
            );
            return (
              <div key={message.id} className="flex justify-center my-3">
                <div className={`inline-flex items-center gap-2.5 px-4 py-2 rounded-full text-sm font-medium border ${
                  pending
                    ? 'bg-amber-500/[0.08] border-amber-500/30 text-amber-800'
                    : 'bg-emerald-500/[0.06] border-emerald-500/25 text-emerald-700'
                }`}>
                  {pending ? (
                    <Loader2 className="w-4 h-4 animate-spin text-amber-600" strokeWidth={2.5} />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" strokeWidth={2.5} />
                  )}
                  <span className="truncate max-w-[60ch]">{message.content}</span>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                    pending ? 'bg-amber-500/20 text-amber-900' : 'bg-emerald-500/15 text-emerald-800'
                  }`}>
                    {pending ? (
                      <><ElapsedTimer startTime={message.timestamp} /> · 응답 대기</>
                    ) : (
                      <>완료</>
                    )}
                  </span>
                </div>
              </div>
            );
          }

          let cleanContent = cleanDisplayContent(message.content || '') || (message.isLoading ? '생각 중...' : '');
          /* 스트리밍 중에는 카드 JSON 이 반쯤 온 상태라 파싱되지 않아 글자로 쏟아진다.
             펜스가 나타난 시점부터는 잘라내고 안내만 둔다 — 완료되면 카드로 그려진다. */
          if (message.isLoading) {
            const cut = CARD_FENCE_STARTS.map(f => cleanContent.indexOf(f)).filter(i => i >= 0);
            if (cut.length) {
              cleanContent = (cleanContent.slice(0, Math.min(...cut)).trim() + '\n\n_초안 카드를 만드는 중…_').trim();
            }
          }

          const mentionAgent = message.mentionAgentId ? agents.find(a => a.id === message.mentionAgentId) : undefined;
          const isMention = !!message.mentionAgentId;
          const mentionLabel = mentionAgent ? `${mentionAgent.emoji || '🤖'} ${mentionAgent.name}` : message.mentionAgentId;

          return (
            <div key={message.id} data-message-id={message.id} className="scroll-mt-20">
              <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
                {/* Avatar */}
                <div className={`flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${
                  isUser ? 'bg-accent' : isMention ? 'bg-purple-50 border border-purple-300 shadow-sm' : 'bg-card border border-border-color shadow-sm'
                }`}>
                  {isUser ? (
                    <User className="w-5 h-5 text-white" />
                  ) : isMention && mentionAgent?.emoji ? (
                    <span className="text-lg">{mentionAgent.emoji}</span>
                  ) : (
                    <Bot className={`w-5 h-5 ${isMention ? 'text-purple-600' : 'text-accent'}`} />
                  )}
                </div>

                {/* Message content */}
                <div className={`flex-1 max-w-[75%] ${isUser ? 'text-right' : ''}`}>
                  {/* Mention badge */}
                  {isMention && (
                    <div className={`mb-1 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-purple-100 border border-purple-300 text-purple-700">
                        {isUser ? '@ ' : '↳ '}{mentionLabel}
                      </span>
                    </div>
                  )}
                  {/* Bubble */}
                  <div className={`inline-block text-left rounded-2xl ${
                    isUser
                      ? isMention
                        ? 'bg-purple-600 text-white px-4 py-3 rounded-tr-md shadow-md shadow-purple-500/20'
                        : 'bg-accent text-white px-4 py-3 rounded-tr-md shadow-md shadow-accent/15'
                      : isMention
                        ? 'bg-purple-50/60 border border-purple-200 border-l-4 border-l-purple-500 px-4 py-3 rounded-tl-md shadow-sm'
                        : 'bg-white border border-black/[0.05] px-4 py-3 rounded-tl-md shadow-sm'
                  }`}>
                    {!isUser && findCards(cleanDisplayContent(message.content || '')) ? (
                      /* 본문 전체가 카드 묶음인 회차 — 코드블록이 아니라 pre 핸들러를 타지 않는다.
                         모델이 ```json 없이 맨 JSON 으로 내보내는 경우가 있다(실측). */
                      <div className="space-y-2">
                        {findCards(cleanDisplayContent(message.content || ''))!.map((c, i) => (
                          <div key={`${message.id}-kc-${i}`}>
                            {renderKindCardTop(c.kind, JSON.stringify(c.data), message.id, i)}
                          </div>
                        ))}
                      </div>
                    ) : !isUser ? (
                      <div className="markdown prose max-w-none text-text-primary">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[rehypeHighlight, rehypeRaw]}
                          components={{
                            /* eslint-disable @typescript-eslint/no-explicit-any */
                            pre: ({ children }) => {
                              const child = children as any;
                              const cls: string = child?.props?.className || '';
                              if (typeof cls === 'string') {
                                const raw = String(child.props.children || '').trim();
                                /* 서브에이전트는 카드를 ```json [{"kind":"sr-table","data":{…}}] 형태로 낸다.
                                   원래는 비서가 이걸 풀어 ```<kind> 로 재발행하기로 했는데 하지 않는다(실측).
                                   멘션으로 직접 부르면 재발행할 비서가 아예 없다 — 화면이 이 형태도 알아본다. */
                                const renderKindCard = (kind: string, data: string, mid: string, i: number) => {
                                  if (kind === 'biz-picker')      return <BizPickerCard raw={data} onSelect={onSendMessage} onIntentPick={onIntentPick} />;
                                  if (kind === 'sr-table')         return <SrTableCard raw={data} />;
                                  if (kind === 'week-picker')      return <WeekPickerCard raw={data} onSelect={onSendMessage} />;
                                  if (kind === 'grouping-editor')  return <GroupingEditorCard raw={data} onSelect={onSendMessage} messageId={`${mid}-${i}`} />;
                                  if (kind === 'draft-card')       return <DraftCard raw={data} onSelect={onSendMessage} onPrefill={onPrefill} srBaseline={findSrBaselineBefore(filtered, idx)} confirmedGroups={findGroupingConfirmBefore(filtered, idx)} />;
                                  if (kind === 'download-card')    return <DownloadCard raw={data} onSelect={onSendMessage} />;
                                  if (kind === 'work-draft')       return <WorkDraftCard raw={data} onSelect={onSendMessage} />;
                                  if (kind === 'tool-pick')        return <ToolPickCard raw={data} onSelect={onSendMessage} />;
                                  return null;
                                };
                                if (cls.includes('language-json')) {
                                  const cards = parseKindCards(raw);
                                  if (cards) {
                                    return (
                                      <>
                                        {cards.map((c, i) => (
                                          <div key={`${message.id}-kind-${i}`}>
                                            {renderKindCard(c.kind, JSON.stringify(c.data), message.id, i)}
                                          </div>
                                        ))}
                                      </>
                                    );
                                  }
                                }
                                if (cls.includes('language-biz-picker'))       return <BizPickerCard raw={raw} onSelect={onSendMessage} onIntentPick={onIntentPick} />;
                                if (cls.includes('language-sr-table'))         return <SrTableCard raw={raw} />;
                                if (cls.includes('language-week-picker'))      return <WeekPickerCard raw={raw} onSelect={onSendMessage} />;
                                if (cls.includes('language-grouping-editor')) return <GroupingEditorCard raw={raw} onSelect={onSendMessage} messageId={message.id} />;
                                if (cls.includes('language-draft-card'))       return <DraftCard raw={raw} onSelect={onSendMessage} onPrefill={onPrefill} srBaseline={findSrBaselineBefore(filtered, idx)} confirmedGroups={findGroupingConfirmBefore(filtered, idx)} />;
                                if (cls.includes('language-download-card'))    return <DownloadCard raw={raw} onSelect={onSendMessage} />;
                                if (cls.includes('language-work-draft'))       return <WorkDraftCard raw={raw} onSelect={onSendMessage} />;
                                if (cls.includes('language-tool-pick'))        return <ToolPickCard raw={raw} onSelect={onSendMessage} />;
                              }
                              return (
                                <pre className="bg-[#f5f4f0] border border-[#e8e6e0] rounded-lg p-3 overflow-x-auto my-2 text-sm">
                                  {children}
                                </pre>
                              );
                            },
                            code: ({ children, className }) => {
                              return !className ? (
                                <code className="bg-accent/[0.07] text-accent px-1.5 py-0.5 rounded text-sm font-mono">
                                  {children}
                                </code>
                              ) : (
                                <code className={className}>{children}</code>
                              );
                            },
                          }}
                        >
                          {cleanContent}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap leading-relaxed">{cleanDisplayContent(stripBootstrapPending(stripCronPrefix(trimFileContent(message.content))))}</p>
                    )}
                  </div>

                  {/* Tool calls */}
                  {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="mt-1">
                      {message.toolCalls.map(tool => renderToolCall(tool))}
                    </div>
                  )}

                  {/* Loading */}
                  {message.isLoading && !message.toolCalls?.length && (
                    <div className="flex items-center gap-2 mt-2 text-text-secondary">
                      <div className="flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-accent/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-accent/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                      <span className="text-xs">응답을 작성하고 있습니다</span>
                    </div>
                  )}

                  {/* Meta: timestamp + actions */}
                  <div className={`flex items-center gap-3 mt-1.5 ${isUser ? 'justify-end' : ''}`}>
                    <span className="text-[11px] text-text-secondary/50">
                      {message.timestamp.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {!isUser && !message.isLoading && message.content.trim().length > 0 && (
                      <MessageActions content={cleanContent} />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
            }),
            /* 사용자 마지막 발화 이후 응답 미도착 → "비서 생각 중" 인라인 카드 */
            showAssistantThinking && (
              <ThinkingCard key="thinking-card" startTime={lastMsg!.timestamp} />
            ),
          ];
        })()
      )}
    </div>
  );
}

function ThinkingCard({ startTime }: { startTime: Date }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center bg-card border border-border-color shadow-sm">
        <Bot className="w-5 h-5 text-accent" />
      </div>
      <div className="flex-1">
        <div className="inline-block rounded-2xl bg-white border border-black/[0.05] px-4 py-2.5 rounded-tl-md shadow-sm">
          <div className="flex items-center gap-2.5 text-text-secondary">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent/50 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-accent/50 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-accent/50 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-xs font-medium">비서가 생각 중입니다</span>
            <span className="text-[10px] font-mono text-text-secondary/60">
              <ElapsedTimer startTime={startTime} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Copy / Download action buttons ─── */
function MessageActions({ content }: { content: string }) {
  const { copied, copy } = useCopy();
  const [downloaded, setDownloaded] = useState(false);

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'message.txt'; a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 1500);
  };

  return (
    <div className="flex gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100" style={{ opacity: 1 }}>
      <button
        onClick={() => copy(content)}
        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-white border border-black/[0.05] text-text-secondary hover:text-accent hover:border-accent/20 transition-all"
      >
        {copied ? <><Check className="w-3 h-3" /> 복사됨!</> : <><Copy className="w-3 h-3" /> 복사</>}
      </button>
      <button
        onClick={handleDownload}
        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-white border border-black/[0.05] text-text-secondary hover:text-accent hover:border-accent/20 transition-all"
      >
        {downloaded ? <><Check className="w-3 h-3" /> 완료!</> : <><Download className="w-3 h-3" /> 다운로드</>}
      </button>
    </div>
  );
}
