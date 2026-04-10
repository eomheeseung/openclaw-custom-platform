import { useState } from 'react';
import { Wifi, WifiOff, LogOut } from 'lucide-react';
import type { ConnectionStatus } from '../types';

interface StatusBarProps {
  connectionStatus: ConnectionStatus;
  currentAgent?: { name: string; emoji?: string };
  onLogout?: () => void;
}

export function StatusBar({ connectionStatus, currentAgent, onLogout }: StatusBarProps) {
  const [showDetails, setShowDetails] = useState(false);

  const getStatusIcon = () => {
    if (!connectionStatus.connected) {
      return <WifiOff className="w-4 h-4 text-red-500" />;
    }
    return <Wifi className="w-4 h-4 text-green-500" />;
  };

  const getStatusText = () => {
    if (connectionStatus.health === 'connecting') return '연결 중...';
    if (!connectionStatus.connected) return '연결 끊김';
    return '정상 연결';
  };

  return (
    <div className="h-12 bg-card border-b border-border-color flex items-center justify-between px-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-accent">TideClaw</span>
        </div>

        {currentAgent && (
          <div className="flex items-center gap-2 px-3 py-1 bg-background rounded-full">
            <span className="text-lg">{currentAgent.emoji || '🤖'}</span>
            <span className="text-sm text-text-primary">{currentAgent.name}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-background rounded-lg cursor-pointer hover:bg-opacity-80 transition-colors"
          onClick={() => setShowDetails(!showDetails)}
        >
          {getStatusIcon()}
          <span className={`text-sm ${connectionStatus.connected ? 'text-green-400' : 'text-red-400'}`}>
            {getStatusText()}
          </span>
        </div>

        {onLogout && (
          <button
            onClick={onLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-red-400 hover:bg-background rounded-lg transition-colors"
            title="로그아웃"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline">로그아웃</span>
          </button>
        )}
      </div>

      {showDetails && connectionStatus.lastPing && (
        <div className="absolute top-12 right-4 bg-card border border-border-color rounded-lg p-3 shadow-lg z-50">
          <p className="text-sm text-text-secondary">
            마지막 핑: {connectionStatus.lastPing.toLocaleTimeString()}
          </p>
        </div>
      )}
    </div>
  );
}
