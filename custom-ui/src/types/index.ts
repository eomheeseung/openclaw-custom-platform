export interface Agent {
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  model?: string;
  subagents?: string[];
  default?: boolean;
}

export interface Session {
  sessionKey: string;
  agentId?: string;
  label?: string;
  createdAt?: string;
  lastMessageAt?: string;
  messageCount?: number;
  derivedTitle?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  attachments?: Attachment[];
  isLoading?: boolean;
  toolCalls?: ToolCall[];
  mentionAgentId?: string;
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  result?: string;
  args?: string;
  duration?: number;
}

export interface ConnectionStatus {
  connected: boolean;
  health: 'ok' | 'error' | 'connecting';
  lastPing?: Date;
}

// TideClaw Protocol Types
export interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
  };
}

export interface EventFrame {
  type: 'event';
  event: string;
  payload: Record<string, unknown>;
  seq?: number;
}

export type ProtocolFrame = RequestFrame | ResponseFrame | EventFrame;
