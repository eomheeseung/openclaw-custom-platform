import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Send, CheckCircle, XCircle, Loader2, Eye, EyeOff, Trash2, ExternalLink, ChevronRight, ArrowRight, AlertTriangle } from 'lucide-react';
import type { ProtocolFrame } from '../types';

interface AgentInfo {
  id: string;
  name: string;
  emoji?: string;
}

interface ChannelManagerProps {
  sendRequest: (method: string, params?: Record<string, unknown>) => Promise<ProtocolFrame>;
  agents?: AgentInfo[];
  token?: string;
}

type ChannelStatus = 'connected' | 'disconnected';

interface GuideStep {
  title: string;
  description: string;
  link?: { url: string; label: string };
}

interface ChannelInfo {
  id: string;
  name: string;
  icon: React.ReactNode;
  color: string;
  tokenField: string;
  placeholder: string;
  guide: GuideStep[];
}

const CHANNELS: ChannelInfo[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    icon: <Send className="w-5 h-5" />,
    color: '#0088CC',
    tokenField: 'botToken',
    placeholder: '123456789:ABCdefGHIjklMNOpqrSTUvwxyz...',
    guide: [
      {
        title: '1. BotFather(봇파더) 열기',
        description: '텔레그램 앱에서 아래 링크를 클릭하거나, 검색창에서 "@BotFather"를 검색하여 대화를 시작하세요.',
        link: { url: 'https://t.me/BotFather', label: 'BotFather 열기 (텔레그램)' },
      },
      {
        title: '2. 새 봇 만들기',
        description: 'BotFather(봇파더)에게 /newbot 명령을 보내세요.',
      },
      {
        title: '3. 봇 이름 설정',
        description: '먼저 봇의 표시 이름을 입력하세요 (예: "내 AI 봇"). 그 다음 유저네임을 입력하세요 (예: "my_ai_bot"). 유저네임은 반드시 "bot"으로 끝나야 합니다.',
      },
      {
        title: '4. 토큰 입력',
        description: 'BotFather(봇파더)가 보내준 토큰을 아래에 붙여넣고 "연결" 버튼을 누르세요.',
      },
      {
        title: '5. 텔레그램에서 사용하기',
        description: '연결 완료 후 텔레그램 앱에서 봇을 사용하는 방법:\n\n1. 텔레그램 앱 상단 검색창에서 @봇유저네임 을 검색하세요 (예: @my_ai_bot)\n2. 봇과의 채팅에 들어가서 "시작" 버튼을 누르세요\n3. 일반 메시지를 보내면 비서가 답장합니다\n\n슬래시(/) 명령어는 무시하고, 평소처럼 대화하면 됩니다.',
      },
    ],
  },
];

export function ChannelManager({ sendRequest, agents = [], token = '' }: ChannelManagerProps) {
  const [channelConfigs, setChannelConfigs] = useState<Record<string, Record<string, unknown>>>({});
  const [channelStatuses, setChannelStatuses] = useState<Record<string, ChannelStatus>>({});
  const [baseHash, setBaseHash] = useState<string>('');
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [guideStep, setGuideStep] = useState(0);
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 디스코드 봇 토큰
  const [agentTokens, setAgentTokens] = useState<Record<string, string>>({});
  const [savingMulti, setSavingMulti] = useState(false);
  const [multiError, setMultiError] = useState('');
  const [multiSuccess, setMultiSuccess] = useState('');
  const [existingAccounts, setExistingAccounts] = useState<Record<string, boolean>>({});
  const [showGuide, setShowGuide] = useState(false);
  const [discordGuideStep, setDiscordGuideStep] = useState(0);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await sendRequest('config.get', {});
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      const config = payload?.config as Record<string, unknown>;
      const hash = payload?.hash as string;
      if (hash) setBaseHash(hash);
      const channels = (config?.channels || {}) as Record<string, Record<string, unknown>>;
      setChannelConfigs(channels);
      const discordConfig = channels?.discord as Record<string, unknown> || {};
      const accounts = (discordConfig?.accounts || {}) as Record<string, Record<string, unknown>>;
      const accMap: Record<string, boolean> = {};
      for (const [key] of Object.entries(accounts)) {
        accMap[key] = true;
      }
      setExistingAccounts(accMap);
    } catch (err) {
      console.error('Failed to fetch config:', err);
    }
  }, [sendRequest]);

  useEffect(() => {
    const statuses: Record<string, ChannelStatus> = {};
    for (const ch of CHANNELS) {
      const config = channelConfigs[ch.id];
      statuses[ch.id] = config?.enabled ? 'connected' : 'disconnected';
    }
    setChannelStatuses(statuses);
  }, [channelConfigs]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const startEditing = (channelId: string) => {
    setEditingChannel(channelId);
    setGuideStep(0);
    setTokenInput('');
    setShowToken(false);
    setError('');
  };

  const stopEditing = () => {
    setEditingChannel(null);
    setGuideStep(0);
    setTokenInput('');
    setShowToken(false);
    setError('');
  };

  const handleSaveToken = async (channelInfo: ChannelInfo) => {
    if (!tokenInput.trim()) { setError('토큰을 입력해주세요'); return; }
    setSaving(true);
    setError('');
    try {
      const getRes = await sendRequest('config.get', {});
      const getPayload = (getRes as { payload?: Record<string, unknown> }).payload;
      const latestHash = getPayload?.hash as string;
      const patch: Record<string, unknown> = {
        channels: {
          [channelInfo.id]: {
            enabled: true,
            [channelInfo.tokenField]: tokenInput.trim(),
            ...(channelInfo.id === 'telegram' ? { dmPolicy: 'open', groupPolicy: 'open', allowFrom: ['*'] } : {}),
          },
        },
      };
      const res = await sendRequest('config.patch', {
        raw: JSON.stringify(patch),
        baseHash: latestHash || baseHash,
      });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      if (payload?.ok) {
        stopEditing();
        setTimeout(() => window.location.reload(), 3000);
      } else {
        setError('설정 저장 실패');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '설정 저장 중 오류 발생');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async (channelInfo: ChannelInfo) => {
    if (!confirm(`${channelInfo.name} 연결을 해제하시겠습니까?\n봇 토큰이 삭제됩니다.`)) return;
    setSaving(true);
    try {
      const getRes = await sendRequest('config.get', {});
      const getPayload = (getRes as { payload?: Record<string, unknown> }).payload;
      const latestHash = getPayload?.hash as string;
      await sendRequest('config.patch', {
        raw: JSON.stringify({ channels: { [channelInfo.id]: { enabled: false, [channelInfo.tokenField]: '' } } }),
        baseHash: latestHash || baseHash,
      });
      setTimeout(() => window.location.reload(), 3000);
    } catch (err) {
      console.error('Disconnect failed:', err);
    } finally {
      setSaving(false);
    }
  };

  // 디스코드 봇 저장 (automap API 호출)
  const handleSaveDiscord = async () => {
    const tokens = Object.entries(agentTokens).filter(([_, v]) => v.trim());
    if (tokens.length === 0) { setMultiError('최소 1개의 토큰을 입력해주세요'); return; }

    // 비서 토큰 확인: 비서가 연결되어 있지 않고, 이번에도 비서 토큰을 안 넣었으면 경고
    const secretaryAgent = agents.find(a => a.id === 'secretary' || a.name === '비서');
    const secretaryId = secretaryAgent?.id;
    if (secretaryId) {
      const secretaryConnected = existingAccounts[secretaryId];
      const secretaryInTokens = tokens.some(([id]) => id === secretaryId);
      if (!secretaryConnected && !secretaryInTokens) {
        setMultiError('비서 봇을 먼저 연결해주세요. 비서가 다른 봇들의 코디네이터 역할을 합니다.');
        return;
      }
    }

    const userMatch = token.match(/user(\d+)/);
    if (!userMatch) { setMultiError('사용자 정보를 확인할 수 없습니다'); return; }
    const userNN = userMatch[1];

    setSavingMulti(true);
    setMultiError('');
    setMultiSuccess('');

    const results: string[] = [];
    const errors: string[] = [];

    for (const [agentId, botToken] of tokens) {
      try {
        setMultiSuccess(`${agentId} 설정 중... (Discord API 조회)`);
        const res = await fetch('/api/automap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userNN, agentId, token: botToken.trim() }),
        });
        const data = await res.json();
        if (data.ok) {
          results.push(agentId);
        } else {
          errors.push(`${agentId}: ${data.error || '실패'}`);
        }
      } catch (err) {
        // NetworkError는 컨테이너 재시작으로 인한 연결 끊김 → 성공으로 간주
        const errMsg = err instanceof Error ? err.message : '';
        if (errMsg.includes('NetworkError') || errMsg.includes('fetch')) {
          results.push(agentId);
        } else {
          errors.push(`${agentId}: ${errMsg || '연결 오류'}`);
        }
      }
    }

    if (errors.length > 0) {
      setMultiError(errors.join('\n'));
    }
    if (results.length > 0) {
      setMultiSuccess(`${results.join(', ')} 봇 연결 완료! 재시작 중입니다. 약 10초 후 자동으로 새로고침됩니다.`);
      setAgentTokens({});
      setTimeout(() => window.location.reload(), 10000);
    }
    setSavingMulti(false);
  };

  // 에이전트 목록: -discord 제외, 비서(default)를 맨 위로
  const filteredAgents = agents
    .filter(a => !a.id.endsWith('-discord'))
    .sort((a, b) => {
      const aDefault = a.id === 'secretary' || a.name === '비서';
      const bDefault = b.id === 'secretary' || b.name === '비서';
      if (aDefault && !bDefault) return -1;
      if (!aDefault && bDefault) return 1;
      return 0;
    });

  const isSecretary = (id: string) => {
    const agent = agents.find(a => a.id === id);
    return id === 'secretary' || agent?.name === '비서';
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-xl font-bold text-text-primary mb-2">채널 연동</h2>
      <p className="text-sm text-text-secondary mb-6">
        외부 메신저와 연동하여 봇과 대화할 수 있습니다.
      </p>

      {/* 디스코드 연동 */}
      <div className="bg-card border border-border-color rounded-xl p-5 mb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white" style={{ backgroundColor: '#5865F2' }}>
            <MessageSquare className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-text-primary">Discord</h3>
            <p className="text-xs text-text-secondary">에이전트별 봇을 연결하면 디스코드에서 AI 팀처럼 동작합니다</p>
          </div>
        </div>

        {/* 봇 생성 가이드 */}
        <div className="mb-4">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="text-sm text-[#5865F2] hover:underline flex items-center gap-1"
          >
            <ChevronRight className={`w-4 h-4 transition-transform ${showGuide ? 'rotate-90' : ''}`} />
            봇 생성 가이드 {showGuide ? '접기' : '보기'}
          </button>

          {showGuide && (() => {
            const steps = [
              {
                title: '1. 디스코드 서버 준비',
                description: '봇을 추가할 디스코드 서버가 필요합니다. 서버가 없다면 디스코드 앱 왼쪽의 "+" 버튼을 눌러 새 서버를 먼저 만드세요. (서버 관리 권한이 있어야 봇을 초대할 수 있습니다.)',
              },
              {
                title: '2. 디스코드 개발자 포털 접속',
                description: '아래 링크를 클릭하여 디스코드 개발자 포털에 로그인하세요.',
                link: { url: 'https://discord.com/developers/applications', label: '디스코드 개발자 포털 열기' },
              },
              {
                title: '3. 새 앱 만들기',
                description: '우측 상단 "New Application" (또는 "신규 애플리케이션") 버튼을 클릭하고, 봇 이름을 입력하세요 (예: 내 AI 봇). 에이전트별로 각각 만들어야 합니다.',
              },
              {
                title: '4. 봇 생성 및 토큰 복사',
                description: '왼쪽 메뉴에서 "봇(Bot)" 클릭 → "Reset Token" (또는 "토큰 초기화") 클릭 → 표시된 토큰을 복사해두세요. (이 토큰은 한 번만 보여집니다! 꼭 메모장 등에 붙여넣어 두세요.)',
              },
              {
                title: '5. Gateway Intents 활성화',
                description: '같은 "봇(Bot)" 페이지에서 아래로 스크롤하면 "Privileged Gateway Intents" 섹션이 있습니다. 다음 3개를 모두 켜주세요:\n\n• Presence Intent → 켜기\n• Server Members Intent → 켜기\n• Message Content Intent → 켜기\n\n이 설정을 안 하면 봇이 메시지를 읽지 못합니다! 변경 후 "Save Changes" (또는 "변경 사항 저장") 버튼을 꼭 누르세요.',
              },
              {
                title: '6. 봇 권한 설정',
                description: '왼쪽 메뉴 "OAuth2" 클릭 → 아래로 스크롤하여 "OAuth2 URL Generator" (또는 "OAuth2 URL 재생기") 찾기 → Scopes에서 "bot" 체크 → 아래 봇 권한(Permissions)에서 다음을 체크하세요:\n\n• 채널 보기\n• 메시지 보내기\n• 메시지 기록 보기\n• 메시지 관리\n• 공개 스레드 만들기\n• 스레드 관리\n• 스레드에서 메시지 보내기\n• 링크 임베드\n• 파일 첨부\n• 반응 추가\n• 외부 이모지 사용',
              },
              {
                title: '7. 봇을 서버에 초대',
                description: '6단계 하단에 생성된 URL을 "Copy" 버튼으로 복사 → 새 브라우저 탭에 붙여넣기 → "서버에 추가" 드롭다운에서 1단계에서 준비한 서버 선택 → "계속하기" → "승인" 클릭.',
              },
              {
                title: '8. 토큰 입력',
                description: '4단계에서 복사해둔 봇 토큰을 아래 에이전트별 입력란에 붙여넣고 "저장" 버튼을 누르세요. 에이전트가 여러 개면 3~7단계를 반복하세요.',
              },
            ];
            const current = steps[discordGuideStep];
            return (
              <div className="mt-3">
                {/* Step indicator */}
                <div className="flex items-center gap-1 mb-3">
                  {steps.map((_, i) => (
                    <div key={i} className="flex items-center">
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors cursor-pointer ${
                          i === discordGuideStep ? 'bg-[#5865F2] text-white' : i < discordGuideStep ? 'bg-green-500/20 text-green-400' : 'bg-background text-text-secondary'
                        }`}
                        onClick={() => setDiscordGuideStep(i)}
                      >
                        {i < discordGuideStep ? <CheckCircle className="w-4 h-4" /> : i + 1}
                      </div>
                      {i < steps.length - 1 && <ChevronRight className="w-4 h-4 text-text-secondary mx-0.5" />}
                    </div>
                  ))}
                </div>

                {/* Current step */}
                <div className="bg-background rounded-lg p-4 mb-3">
                  <h4 className="text-sm font-semibold text-text-primary mb-2">{current.title}</h4>
                  <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-line">{current.description}</p>
                  {current.link && (
                    <a href={current.link.url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 text-sm bg-[#5865F2]/10 text-[#5865F2] hover:bg-[#5865F2]/20 rounded-lg transition-colors">
                      <ExternalLink className="w-4 h-4" /> {current.link.label}
                    </a>
                  )}
                </div>

                {/* Navigation */}
                <div className="flex items-center justify-end gap-2">
                  {discordGuideStep > 0 && (
                    <button onClick={() => setDiscordGuideStep(discordGuideStep - 1)}
                      className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-background rounded-lg transition-colors">이전</button>
                  )}
                  {discordGuideStep < steps.length - 1 && (
                    <button onClick={() => setDiscordGuideStep(discordGuideStep + 1)}
                      className="px-3 py-1.5 text-xs bg-[#5865F2]/10 text-[#5865F2] hover:bg-[#5865F2]/20 rounded-lg transition-colors flex items-center gap-1">
                      다음 <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        {/* 에이전트별 토큰 입력 */}
        <div className="space-y-2">
          {filteredAgents.map(agent => {
            const hasAccount = existingAccounts[agent.id];
            const isEditing = agentTokens[agent.id] !== undefined;
            const isRequired = isSecretary(agent.id);

            return (
              <div key={agent.id} className="flex items-center gap-3 p-3 bg-background/50 rounded-lg">
                <span className="text-xl w-8 text-center">{agent.emoji || '🤖'}</span>
                <span className="text-sm font-medium text-text-primary w-24 truncate">
                  {agent.name}
                  {isRequired && <span className="text-[10px] text-amber-400 ml-1">(필수)</span>}
                </span>
                {hasAccount && !isEditing ? (
                  <div className="flex-1 flex items-center gap-2">
                    <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> 연결됨</span>
                    <button
                      onClick={() => setAgentTokens(prev => ({ ...prev, [agent.id]: '' }))}
                      className="text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded transition-colors"
                    >
                      변경
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`${agent.name} 봇 연결을 해제하시겠습니까?`)) return;
                        try {
                          const gr = await sendRequest('config.get', {});
                          const gp = (gr as { payload?: Record<string, unknown> }).payload;
                          const h = gp?.hash as string;
                          await sendRequest('config.patch', {
                            raw: JSON.stringify({ channels: { discord: { accounts: { [agent.id]: null } } } }),
                            baseHash: h,
                          });
                          setTimeout(() => window.location.reload(), 3000);
                        } catch { /* ignore */ }
                      }}
                      className="text-xs text-text-secondary hover:text-red-400 px-2 py-1 rounded transition-colors"
                    >
                      해제
                    </button>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center gap-2">
                    <input
                      type="password"
                      value={agentTokens[agent.id] || ''}
                      onChange={(e) => setAgentTokens(prev => ({ ...prev, [agent.id]: e.target.value }))}
                      placeholder="봇 토큰 입력..."
                      className="flex-1 px-3 py-1.5 bg-background border border-border-color rounded-lg text-text-primary text-xs font-mono focus:outline-none focus:border-accent"
                    />
                    {isEditing && hasAccount && (
                      <button
                        onClick={() => setAgentTokens(prev => { const n = { ...prev }; delete n[agent.id]; return n; })}
                        className="text-xs text-text-secondary hover:text-text-primary px-2 py-1"
                      >
                        취소
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {multiError && (
          <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-400 text-sm whitespace-pre-line">{multiError}</p>
          </div>
        )}
        {multiSuccess && <p className="text-green-400 text-sm mt-3">{multiSuccess}</p>}

        <div className="flex justify-end mt-4">
          <button
            onClick={handleSaveDiscord}
            disabled={savingMulti || Object.values(agentTokens).filter(v => v.trim()).length === 0}
            className="px-5 py-2 text-sm bg-[#5865F2] hover:bg-[#4752C4] text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {savingMulti && <Loader2 className="w-4 h-4 animate-spin" />}
            저장
          </button>
        </div>
      </div>

      {/* 텔레그램 등 기타 채널 */}
      <div className="space-y-4">
        {CHANNELS.map(ch => {
          const isConnected = channelStatuses[ch.id] === 'connected';
          const isEditingCh = editingChannel === ch.id;
          const isLastStep = guideStep >= ch.guide.length - 1;
          const currentGuide = ch.guide[guideStep];

          return (
            <div key={ch.id} className="bg-card border border-border-color rounded-xl p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white" style={{ backgroundColor: ch.color }}>
                    {ch.icon}
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">{ch.name}</h3>
                    {isConnected
                      ? <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle className="w-3 h-3" /> 연결됨</span>
                      : <span className="flex items-center gap-1 text-xs text-text-secondary"><XCircle className="w-3 h-3" /> 미연결</span>
                    }
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isConnected && !isEditingCh && (
                    <>
                      <button onClick={() => startEditing(ch.id)} className="px-3 py-1.5 text-xs bg-background text-text-secondary hover:text-text-primary rounded-lg transition-colors">토큰 변경</button>
                      <button onClick={() => handleDisconnect(ch)} className="p-1.5 text-text-secondary hover:text-red-400 rounded-lg transition-colors" title="연결 해제"><Trash2 className="w-4 h-4" /></button>
                    </>
                  )}
                  {!isConnected && !isEditingCh && (
                    <button onClick={() => startEditing(ch.id)} className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors">연결하기</button>
                  )}
                </div>
              </div>

              {/* 연결됨 상태에서 사용 가이드 표시 */}
              {isConnected && !isEditingCh && ch.id === 'telegram' && (
                <div className="mt-4 p-4 bg-background rounded-lg border border-border-color">
                  <h4 className="text-sm font-semibold text-text-primary mb-2">텔레그램에서 사용하기</h4>
                  <div className="text-sm text-text-secondary space-y-1.5">
                    <p>1. 텔레그램 앱 상단 검색창에서 <strong className="text-text-primary">@봇유저네임</strong>을 검색하세요</p>
                    <p>2. 봇과의 채팅에 들어가서 <strong className="text-text-primary">"시작"</strong> 버튼을 누르세요</p>
                    <p>3. 일반 메시지를 보내면 비서가 답장합니다</p>
                  </div>
                  <p className="text-xs text-text-secondary mt-2 opacity-60">슬래시(/) 명령어는 무시하고, 평소처럼 대화하면 됩니다.</p>
                </div>
              )}

              {isEditingCh && (
                <div className="mt-5">
                  <div className="flex items-center gap-1 mb-4">
                    {ch.guide.map((_, i) => (
                      <div key={i} className="flex items-center">
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors cursor-pointer ${
                            i === guideStep ? 'bg-accent text-white' : i < guideStep ? 'bg-green-500/20 text-green-400' : 'bg-background text-text-secondary'
                          }`}
                          onClick={() => setGuideStep(i)}
                        >
                          {i < guideStep ? <CheckCircle className="w-4 h-4" /> : i + 1}
                        </div>
                        {i < ch.guide.length - 1 && <ChevronRight className="w-4 h-4 text-text-secondary mx-0.5" />}
                      </div>
                    ))}
                  </div>
                  <div className="bg-background rounded-lg p-4 mb-4">
                    <h4 className="text-sm font-semibold text-text-primary mb-2">{currentGuide.title}</h4>
                    <p className="text-sm text-text-secondary leading-relaxed">{currentGuide.description}</p>
                    {currentGuide.link && (
                      <a href={currentGuide.link.url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 text-sm bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors">
                        <ExternalLink className="w-4 h-4" /> {currentGuide.link.label}
                      </a>
                    )}
                  </div>
                  {isLastStep && (
                    <div className="mb-4">
                      <div className="relative">
                        <input
                          type={showToken ? 'text' : 'password'}
                          value={tokenInput}
                          onChange={(e) => setTokenInput(e.target.value)}
                          placeholder={ch.placeholder}
                          className="w-full px-4 py-3 bg-background border-2 border-accent/30 rounded-lg text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent transition-colors pr-10 font-mono text-sm"
                          autoFocus
                        />
                        <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary">
                          {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <button onClick={stopEditing} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">취소</button>
                    <div className="flex items-center gap-2">
                      {guideStep > 0 && (
                        <button onClick={() => setGuideStep(guideStep - 1)} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary bg-background rounded-lg transition-colors">이전</button>
                      )}
                      {!isLastStep ? (
                        <button onClick={() => setGuideStep(guideStep + 1)} className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors flex items-center gap-1">
                          다음 <ArrowRight className="w-4 h-4" />
                        </button>
                      ) : (
                        <button onClick={() => handleSaveToken(ch)} disabled={saving || !tokenInput.trim()}
                          className="px-5 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
                          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                          연결
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
