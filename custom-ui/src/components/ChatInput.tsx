import { useState, useRef, useCallback } from 'react';
import { Send, Square, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';

interface ChatInputProps {
  onSendMessage: (content: string, attachments?: File[]) => void;
  onStop?: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  agentName?: string;
  model?: string;
}

export function ChatInput({ onSendMessage, onStop, disabled, isLoading, agentName, model }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 응답 중이거나 disconnected이면 입력 자체 막음
  const isInputBlocked = disabled || isLoading;

  const handleSubmit = useCallback(() => {
    if ((!message.trim() && attachments.length === 0) || isInputBlocked) return;
    
    onSendMessage(message.trim(), attachments.length > 0 ? attachments : undefined);
    setMessage('');
    setAttachments([]);
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [message, attachments, isInputBlocked, onSendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
      <div className={`flex items-end gap-2.5 bg-background border rounded-2xl px-3 py-2.5 transition-all ${
        isInputBlocked
          ? 'border-border-color/50 opacity-60 cursor-not-allowed'
          : 'border-border-color focus-within:border-accent/30 focus-within:shadow-[0_0_0_3px_rgba(26,122,102,0.06)]'
      }`}>
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
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary/60 hover:text-accent hover:bg-accent/5 transition-all text-base font-semibold disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="에이전트 지정"
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
          onChange={(e) => setMessage(e.target.value)}
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
