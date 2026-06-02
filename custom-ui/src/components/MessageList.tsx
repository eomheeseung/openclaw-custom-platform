import { useRef, useEffect, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { User, Bot, Loader2, Copy, Download, Check, CheckCircle2 } from 'lucide-react';
import type { Message, Agent } from '../types';
import { shouldHideMessage, cleanDisplayContent } from '../utils/messageFilter';

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

/* OpenClaw [Bootstrap pending] 블록 + Sender 메타 + timestamp prefix 제거,
   진짜 사용자 본문만 남김 */
function stripBootstrapPending(content: string): string {
  if (!content) return content;
  let out = content;
  // [Bootstrap pending] 블록과 그 안내문 제거
  if (out.startsWith('[Bootstrap pending]')) {
    const re = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[+-]\d+\]\s*/g;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) lastMatch = m;
    if (lastMatch) out = out.slice(lastMatch.index + lastMatch[0].length);
  } else {
    // [Bootstrap pending] 없이도 leading timestamp prefix 한 개는 정리
    out = out.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[+-]\d+\]\s*/, '');
  }
  return out.trim();
}

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
}

export function MessageList({ messages, agents = [] }: MessageListProps) {
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
            if (m.role === 'system' && (m.id.startsWith('working-') || (m.toolCalls && m.toolCalls.length > 0))) return true;
            return !shouldHideMessage(m.role, m.content || '');
          });
          /* 마지막 user 메시지 이후 assistant 응답이 아직 없는지 — "비서 생각 중" 카드 결정용 */
          const lastIdx = filtered.length - 1;
          const lastMsg = filtered[lastIdx];
          const showAssistantThinking =
            lastMsg && lastMsg.role === 'user' && !lastMsg.isLoading;
          return [
            ...filtered.map((message, idx) => {
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

          const cleanContent = cleanDisplayContent(message.content || '') || (message.isLoading ? '생각 중...' : '');

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
                    {!isUser ? (
                      <div className="markdown prose max-w-none text-text-primary">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[rehypeHighlight, rehypeRaw]}
                          components={{
                            pre: ({ children }) => (
                              <pre className="bg-[#f5f4f0] border border-[#e8e6e0] rounded-lg p-3 overflow-x-auto my-2 text-sm">
                                {children}
                              </pre>
                            ),
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
                      <p className="whitespace-pre-wrap leading-relaxed">{stripBootstrapPending(stripCronPrefix(trimFileContent(message.content)))}</p>
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
