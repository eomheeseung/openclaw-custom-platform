import { useRef, useEffect, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { User, Bot, Loader2, Copy, Download, Check } from 'lucide-react';
import type { Message, Agent } from '../types';

/* 사용자 메시지에서 [파일: xxx] 라벨 다음의 inline 텍스트를 라벨만 남기고 제거 */
function trimFileContent(content: string): string {
  if (!content || !content.includes('[파일:')) return content;
  return content.replace(/(\[파일:\s*[^\]]+\])\n[\s\S]*?(?=\n*\[파일:|$)/g, '$1');
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

  useEffect(() => {
    if (scrollRef.current) {
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
      className="flex-1 overflow-y-auto scrollbar-thin px-6 py-5 space-y-5"
    >
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-text-secondary">
          <Bot className="w-16 h-16 mb-4 opacity-30" />
          <p className="text-lg font-medium">TideClaw에 오신 것을 환영합니다</p>
          <p className="text-sm mt-2 opacity-60">메시지를 입력하여 대화를 시작하세요</p>
        </div>
      ) : (
        messages.filter(m => {
          if (m.role === 'system') {
            const c = m.content;
            if (c.includes('작업 중...') || c.includes('완료')) return true;
            if (c.includes('---\nname:') || c.includes('```bash') || c.includes('Weather report') || c.includes('curl ') || c.startsWith('{') || c.includes('OpenClaw runtime') || c.includes('BEGIN_UNTRUSTED') || c.includes('runtime-generated') || c.includes('[Internal task') || c.includes('Sender (untrusted')) return false;
          }
          if (m.content.includes('===SOUL.md===') || m.content.includes('===IDENTITY.md===') || m.content.includes('===EMOJI===') || m.content.includes('HEARTBEAT.md') || m.content.includes('===AGENTS.md===')) return false;
          if (m.role === 'assistant') {
            const t = m.content.trim();
            if (t.startsWith('{') && t.includes('"status"') && t.includes('"accepted"')) return false;
            if (t.startsWith('{') && (t.includes('"results"') || t.includes('"provider"') || t.includes('"score"'))) return false;
            if (t.includes('"childSessionKey"') && t.includes('"status": "accepted"')) return false;
            if (t.includes('"modelApplied"') && t.includes('"runId"')) return false;
            if (t.includes('Successfully wrote') && t.includes('bytes to')) return false;
            if (t === 'Source: memory/' || /^Source: memory\//.test(t)) return false;
          }
          if (m.role === 'assistant' && !m.isLoading && m.content.trim().length < 2) return false;
          return true;
        }).map((message) => {
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

          // Delegation badge — 위임 표시 (데모처럼)
          if (isSystem) {
            return (
              <div key={message.id} className="flex justify-center my-3">
                <div className="inline-flex items-center gap-3 px-5 py-2.5 rounded-full text-sm font-medium bg-amber-500/[0.06] border border-amber-500/20 text-amber-700">
                  <span>{message.content}</span>
                </div>
              </div>
            );
          }

          const cleanContent = (message.content || (message.isLoading ? '생각 중...' : ''))
            .replace(/```json\s*\{\s*"status"\s*:\s*"accepted"[\s\S]*?"modelApplied":\s*true\s*\}\s*```/g, '')
            .replace(/\{\s*"status"\s*:\s*"accepted"[\s\S]*?"modelApplied":\s*true\s*\}/g, '')
            .replace(/\n?Source: memory\/[^\n]*/g, '')
            .replace(/\n?Successfully wrote \d+ bytes to [^\n]*/g, '')
            .trim() || (message.isLoading ? '생각 중...' : '');

          const mentionAgent = message.mentionAgentId ? agents.find(a => a.id === message.mentionAgentId) : undefined;
          const isMention = !!message.mentionAgentId;
          const mentionLabel = mentionAgent ? `${mentionAgent.emoji || '🤖'} ${mentionAgent.name}` : message.mentionAgentId;

          return (
            <div key={message.id}>
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
                      <p className="whitespace-pre-wrap leading-relaxed">{trimFileContent(message.content)}</p>
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
        })
      )}
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
