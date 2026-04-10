import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Send, Square, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import type { Agent } from '../types';

interface ChatInputProps {
  onSendMessage: (content: string, attachments?: File[]) => void;
  onStop?: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  agentName?: string;
  model?: string;
  agents?: Agent[];
  currentAgentId?: string;
}

export function ChatInput({ onSendMessage, onStop, disabled, isLoading, agentName, model, agents = [], currentAgentId }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);

  // 멘션 대상 후보: 현재 에이전트 제외 + discord 변형 제외
  const mentionCandidates = useMemo(() => {
    return agents.filter(a => a.id !== currentAgentId && !a.id.endsWith('-discord'));
  }, [agents, currentAgentId]);

  const filteredAgents = useMemo(() => {
    if (!mentionQuery) return mentionCandidates;
    const q = mentionQuery.toLowerCase();
    return mentionCandidates.filter(a =>
      a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
    );
  }, [mentionCandidates, mentionQuery]);

  useEffect(() => {
    if (mentionIndex >= filteredAgents.length) setMentionIndex(0);
  }, [filteredAgents, mentionIndex]);

  // 키보드 네비 시 선택 항목을 스크롤 뷰로 이동
  useEffect(() => {
    if (!mentionOpen) return;
    const el = mentionItemRefs.current[mentionIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [mentionIndex, mentionOpen]);

  // 드롭다운/textarea 바깥 클릭 시 닫기
  useEffect(() => {
    if (!mentionOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mentionDropdownRef.current?.contains(target)) return;
      if (textareaRef.current?.contains(target)) return;
      setMentionOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [mentionOpen]);

  // 응답 중이거나 disconnected이면 입력 자체 막음
  const isInputBlocked = disabled || isLoading;

  const handleSubmit = useCallback(() => {
    if ((!message.trim() && attachments.length === 0) || isInputBlocked) return;

    onSendMessage(message.trim(), attachments.length > 0 ? attachments : undefined);
    setMessage('');
    setAttachments([]);
    setMentionOpen(false);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [message, attachments, isInputBlocked, onSendMessage]);

  // 커서 앞 텍스트에서 @query 감지. 공백 전까지, 아직 단어 중이면 오픈.
  const detectMention = useCallback((value: string, cursorPos: number) => {
    const before = value.slice(0, cursorPos);
    const atIdx = before.lastIndexOf('@');
    if (atIdx < 0) return { open: false, start: -1, query: '' };
    // @ 앞 글자가 공백/줄바꿈이거나 맨 앞이어야 함
    const prevCh = atIdx > 0 ? before[atIdx - 1] : ' ';
    if (prevCh !== ' ' && prevCh !== '\n' && atIdx !== 0) {
      return { open: false, start: -1, query: '' };
    }
    const query = before.slice(atIdx + 1);
    // 공백이 포함되면 멘션 종료
    if (/\s/.test(query)) return { open: false, start: -1, query: '' };
    return { open: true, start: atIdx, query };
  }, []);

  const insertMention = useCallback((agent: Agent) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? message.length;
    if (mentionStart < 0) return;
    const before = message.slice(0, mentionStart);
    const after = message.slice(cursor);
    const inserted = `@${agent.id} `;
    const next = before + inserted + after;
    setMessage(next);
    setMentionOpen(false);
    setMentionQuery('');
    setMentionStart(-1);
    // 커서 위치 복원
    const nextCursor = before.length + inserted.length;
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCursor, nextCursor);
      }
    });
  }, [message, mentionStart]);

  const handleMessageChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setMessage(value);
    const cursorPos = e.target.selectionStart ?? value.length;
    const m = detectMention(value, cursorPos);
    setMentionOpen(m.open);
    setMentionStart(m.start);
    setMentionQuery(m.query);
    if (m.open) setMentionIndex(0);
  }, [detectMention]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && filteredAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex(i => (i + 1) % filteredAgents.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex(i => (i - 1 + filteredAgents.length) % filteredAgents.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(filteredAgents[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith('image/'));
    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems.map(item => item.getAsFile()).filter(Boolean) as File[];
      setAttachments(prev => [...prev, ...files]);
    }
  };

  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setAttachments(prev => [...prev, ...files]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    setAttachments(prev => [...prev, ...files]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const getFileIcon = (type: string) => {
    if (type.startsWith('image/')) return <ImageIcon className="w-4 h-4" />;
    return <FileText className="w-4 h-4" />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  return (
    <div 
      className={`border-t border-border-color bg-card p-4 ${isDragging ? 'bg-accent bg-opacity-10' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {attachments.map((file, index) => (
            <div 
              key={index}
              className="flex items-center gap-2 px-3 py-1.5 bg-background rounded-lg text-sm"
            >
              {getFileIcon(file.type)}
              <span className="text-text-primary truncate max-w-[150px]">{file.name}</span>
              <span className="text-text-secondary text-xs">({formatFileSize(file.size)})</span>
              <button
                onClick={() => removeAttachment(index)}
                className="p-0.5 hover:bg-border-color rounded transition-colors"
              >
                <X className="w-3 h-3 text-text-secondary" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input wrapper */}
      <div className={`relative flex items-end gap-2.5 bg-background border rounded-2xl px-3 py-2.5 transition-all ${
        isInputBlocked
          ? 'border-border-color/50 opacity-60 cursor-not-allowed'
          : 'border-border-color focus-within:border-accent/30 focus-within:shadow-[0_0_0_3px_rgba(26,122,102,0.06)]'
      }`}>
        {/* @ mention dropdown */}
        {mentionOpen && filteredAgents.length > 0 && (
          <div ref={mentionDropdownRef} className="absolute bottom-full left-0 mb-2 w-64 max-h-64 overflow-y-auto bg-card border border-border-color rounded-xl shadow-lg z-20">
            <div className="px-3 py-1.5 text-[11px] text-text-secondary border-b border-border-color">
              @ 에이전트 수동 호출
            </div>
            {filteredAgents.map((a, i) => (
              <button
                key={a.id}
                ref={(el) => { mentionItemRefs.current[i] = el; }}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); insertMention(a); }}
                onMouseEnter={() => setMentionIndex(i)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                  i === mentionIndex ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-accent/5'
                }`}
              >
                <span className="text-base">{a.emoji || '🤖'}</span>
                <span className="flex-1 truncate">{a.name}</span>
                <span className="text-[10px] text-text-secondary/60 font-mono">{a.id}</span>
              </button>
            ))}
          </div>
        )}

        {/* Tool buttons */}
        <div className="flex gap-0.5 flex-shrink-0 pb-0.5">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary/60 hover:text-accent hover:bg-accent/5 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            disabled={isInputBlocked}
            title="파일 첨부"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const ta = textareaRef.current;
              if (!ta) return;
              ta.focus();
              const cursor = ta.selectionStart ?? message.length;
              const before = message.slice(0, cursor);
              const after = message.slice(cursor);
              const needsSpace = before.length > 0 && !/\s$/.test(before);
              const prefix = needsSpace ? ' @' : '@';
              const next = before + prefix + after;
              setMessage(next);
              const nextCursor = before.length + prefix.length;
              setMentionOpen(true);
              setMentionStart(nextCursor - 1);
              setMentionQuery('');
              setMentionIndex(0);
              requestAnimationFrame(() => {
                if (textareaRef.current) {
                  textareaRef.current.focus();
                  textareaRef.current.setSelectionRange(nextCursor, nextCursor);
                }
              });
            }}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary/60 hover:text-accent hover:bg-accent/5 transition-all text-base font-semibold disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="에이전트 멘션"
            disabled={isInputBlocked}
          >
            @
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleMessageChange}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          onDrop={(e) => { if (isInputBlocked) return; e.preventDefault(); e.stopPropagation(); setIsDragging(false); const files = Array.from(e.dataTransfer.files); if (files.length > 0) setAttachments(prev => [...prev, ...files]); }}
          onDragOver={(e) => e.preventDefault()}
          placeholder={isLoading ? '응답 생성 중입니다...' : disabled ? '연결 끊김' : '메시지를 입력하세요...'}
          disabled={isInputBlocked}
          rows={1}
          className="flex-1 bg-transparent border-none text-text-primary placeholder-text-secondary/50 resize-none focus:outline-none py-1.5 text-[15px] leading-relaxed disabled:cursor-not-allowed"
          style={{ minHeight: '36px', maxHeight: '120px' }}
        />

        {/* Send / Stop */}
        {isLoading ? (
          <button
            onClick={onStop}
            className="w-9 h-9 bg-red-500 hover:bg-red-600 text-white rounded-xl flex items-center justify-center transition-colors flex-shrink-0"
            title="응답 중지"
          >
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={(!message.trim() && attachments.length === 0) || isInputBlocked}
            className="w-9 h-9 bg-accent hover:bg-accent-hover disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl flex items-center justify-center transition-all hover:scale-105 active:scale-95 flex-shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Hint bar */}
      <div className="flex items-center justify-between px-1 pt-1.5 text-xs text-text-secondary/50">
        <span>
          <kbd className="px-1.5 py-0.5 rounded border border-border-color bg-card text-[10px] font-mono">Enter</kbd> 전송 · <kbd className="px-1.5 py-0.5 rounded border border-border-color bg-card text-[10px] font-mono">Shift+Enter</kbd> 줄바꿈
        </span>
        {agentName && (
          <span>{agentName}{model ? ` · ${model}` : ''}</span>
        )}
      </div>

      {isDragging && (
        <div className="absolute inset-0 bg-accent/5 border-2 border-dashed border-accent rounded-2xl flex items-center justify-center pointer-events-none">
          <p className="text-accent font-medium">파일을 여기에 드롭하세요</p>
        </div>
      )}
    </div>
  );
}
