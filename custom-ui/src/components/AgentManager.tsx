import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, Save, X, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import type { ProtocolFrame } from '../types';

interface AgentManagerProps {
  sendRequest: (method: string, params?: Record<string, unknown>) => Promise<ProtocolFrame>;
  onAgentsChanged: () => void;
  token?: string;
}

interface AgentEntry {
  id: string;
  name: string;
  default?: boolean;
  identity?: { name?: string; emoji?: string };
  subagents?: { allowAgents?: string[] };
}

interface AgentFile {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  content?: string;
}

export function AgentManager({ sendRequest, onAgentsChanged, token = '' }: AgentManagerProps) {
  const syncAgents = async () => {
    const userMatch = token.match(/user(\d+)/);
    if (!userMatch) return;
    try { await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userNN: userMatch[1] }) }); } catch { /* ignore */ }
    // config 자동 재로드 대기 후 새로고침
    setTimeout(() => window.location.reload(), 3000);
  };
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<string | null>(null);
  const [agentFiles, setAgentFiles] = useState<AgentFile[]>([]);
  const [editingFile, setEditingFile] = useState<{ agentId: string; name: string; content: string } | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create form
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState('');
  const [newId, setNewId] = useState('');
  const [newSubagents, setNewSubagents] = useState<string[]>([]);
  const [newParent, setNewParent] = useState<string>('');

  // AI 프로필 생성
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileInput, setProfileInput] = useState('');
  const [profileGenerating, setProfileGenerating] = useState(false);
  const [pendingAgentId, setPendingAgentId] = useState('');

  // Edit form
  const [editName, setEditName] = useState('');
  const [editEmoji, setEditEmoji] = useState('');
  const [editSubagents, setEditSubagents] = useState<string[]>([]);

  // Auto-update TOOLS.md when subagents change
  const updateSubagentTools = useCallback(async (agentId: string, subagentIds: string[], allAgents: AgentEntry[]) => {
    if (subagentIds.length === 0) return;
    try {
      // Read existing TOOLS.md
      let existingContent = '';
      try {
        const res = await sendRequest('agents.files.get', { agentId, name: 'TOOLS.md' });
        const payload = (res as { payload?: Record<string, unknown> }).payload;
        const file = payload?.file as { content?: string; missing?: boolean } | undefined;
        if (file && !file.missing) existingContent = file.content || '';
      } catch { /* file doesn't exist yet */ }

      // Check if auto-generated section already exists
      const autoMarker = '<!-- AUTO:SUBAGENTS -->';
      const autoEndMarker = '<!-- /AUTO:SUBAGENTS -->';
      const subagentInfo = subagentIds.map(sid => {
        const sa = allAgents.find(a => a.id === sid);
        const name = sa?.identity?.name || sa?.name || sid;
        return `- **${name}** (agentId: "${sid}")`;
      }).join('\n');

      const autoSection = `${autoMarker}
## 서브에이전트 활용

등록된 서브에이전트가 있습니다. \`sessions_spawn\` 도구로 작업을 위임할 수 있습니다.

### 사용 가능한 서브에이전트
${subagentInfo}

### 사용법
\`\`\`
sessions_spawn(task: "작업 내용", agentId: "에이전트ID", mode: "run")
\`\`\`
- mode="run": 일회성 작업 후 결과 반환
- mode="session": 지속적 대화

### 규칙
- 서브에이전트에게 위임할 때 충분한 컨텍스트를 함께 전달하세요
- 서브에이전트의 결과를 받아서 사용자에게 요약 보고하세요
- 사용자가 관련 작업을 요청하면 적절한 서브에이전트에게 자동으로 위임하세요
${autoEndMarker}`;

      let newContent: string;
      if (existingContent.includes(autoMarker)) {
        // Replace existing auto section
        const regex = new RegExp(`${autoMarker}[\\s\\S]*?${autoEndMarker}`);
        newContent = existingContent.replace(regex, autoSection);
      } else {
        // Append auto section
        newContent = existingContent ? `${existingContent}\n\n${autoSection}` : autoSection;
      }

      await sendRequest('agents.files.set', {
        agentId,
        name: 'TOOLS.md',
        content: newContent,
      });
    } catch (err) {
      console.error('Failed to update TOOLS.md for subagents:', err);
    }
  }, [sendRequest]);

  const loadAgents = useCallback(async () => {
    try {
      setLoading(true);
      // Read from config to get subagents info (agents.list doesn't include it)
      const configRes = await sendRequest('config.get', {});
      const configPayload = (configRes as { payload?: Record<string, unknown> }).payload;
      const config = configPayload?.config as Record<string, unknown>;
      const agentsConfig = config?.agents as Record<string, unknown> || {};
      const list = (agentsConfig?.list as Array<Record<string, unknown>>) || [];
      const mapped: AgentEntry[] = list.map(a => ({
        id: (a.id as string) || '',
        name: (a.name as string) || '',
        default: a.default as boolean | undefined,
        identity: a.identity as { name?: string; emoji?: string } | undefined,
        subagents: a.subagents as { allowAgents?: string[] } | undefined,
      }));
      setAgents(mapped);
    } catch (err) {
      setError('에이전트 목록을 불러올 수 없습니다');
    } finally {
      setLoading(false);
    }
  }, [sendRequest]);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  const showMessage = (msg: string, isError = false) => {
    if (isError) { setError(msg); setSuccess(''); }
    else { setSuccess(msg); setError(''); }
    setTimeout(() => { setError(''); setSuccess(''); }, 3000);
  };

  const generateAgentProfile = async (agentId: string, description: string) => {
    setProfileGenerating(true);
    try {
      // 임시 세션에서 AI한테 프로필 생성 요청
      const sessionKey = `agent:developer:profile-gen-${Date.now()}`;
      const prompt = `다음 설명을 바탕으로 AI 에이전트의 시스템 프롬프트 파일들을 생성해주세요.

에이전트 이름: ${agentId}
설명: ${description}

아래 형식으로 정확히 작성해주세요. 각 섹션은 ===FILENAME=== 으로 구분합니다.

===EMOJI===
(이 에이전트를 가장 잘 나타내는 이모지 1개만. 예: 📢, ⚖️, 💰, 🎨 등)

===SOUL.md===
(에이전트의 성격, 말투, 역할을 정의. 한국어로 작성)

===IDENTITY.md===
(에이전트의 자기소개, 전문 분야, 능력을 정의. 한국어로 작성)

각 파일의 내용만 작성하고, 다른 설명은 하지 마세요.`;

      const res = await sendRequest('chat.send', {
        sessionKey,
        message: prompt,
        idempotencyKey: `profile-${Date.now()}`,
      });

      // 응답 대기 (최대 30초)
      let retries = 0;
      let result = '';
      while (retries < 30) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const histRes = await sendRequest('chat.history', { sessionKey, limit: 10 });
          const histPayload = (histRes as { payload?: Record<string, unknown> }).payload;
          const msgs = (histPayload?.messages || []) as Array<{ role: string; content: Array<{ type: string; text?: string }> | string }>;
          const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            const content = lastAssistant.content;
            if (typeof content === 'string') result = content;
            else if (Array.isArray(content)) result = content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('');
            if (result.includes('===SOUL.md===') || result.includes('# ')) break;
          }
        } catch { /* retry */ }
        retries++;
      }

      if (!result) {
        // AI 응답 없으면 기본 템플릿 사용
        result = `===SOUL.md===\n# ${agentId} 성격\n\n## 역할\n${description}\n\n## 말투\n- 한국어로 대화합니다\n- 전문적이고 친근한 톤\n\n===IDENTITY.md===\n# ${agentId}\n\n## 전문 분야\n${description}\n`;
      }

      // 이모지 추출
      let aiEmoji = '';
      const emojiMatch = result.match(/===EMOJI===\s*\n?\s*(.+)/);
      if (emojiMatch) {
        aiEmoji = emojiMatch[1].trim();
      }

      // 파싱: ===FILENAME=== 으로 분리
      const files: Record<string, string> = {};
      const sections = result.split(/===([A-Z_]+\.md)===/);
      for (let i = 1; i < sections.length; i += 2) {
        const filename = sections[i];
        const content = (sections[i + 1] || '').trim();
        if (filename && content) {
          files[filename] = content;
        }
      }

      // 파싱 실패 시 전체를 SOUL.md로
      if (Object.keys(files).length === 0) {
        files['SOUL.md'] = result;
      }

      // 파일 저장
      for (const [filename, content] of Object.entries(files)) {
        try {
          await sendRequest('agents.files.set', {
            agentId,
            name: filename,
            content,
          });
        } catch { /* ignore individual file errors */ }
      }

      // AI가 추천한 이모지로 에이전트 config 업데이트
      if (aiEmoji) {
        try {
          const configRes2 = await sendRequest('config.get', {});
          const cp2 = (configRes2 as { payload?: Record<string, unknown> }).payload;
          const hash2 = cp2?.hash as string;
          const cfg2 = cp2?.config as Record<string, unknown>;
          const ac2 = cfg2?.agents as Record<string, unknown> || {};
          const list2 = (ac2?.list as Array<Record<string, unknown>>) || [];
          const updatedList = list2.map(a => {
            if ((a as { id: string }).id === agentId) {
              return { ...a, identity: { ...(a.identity as Record<string, unknown> || {}), emoji: aiEmoji } };
            }
            return a;
          });
          cfg2.agents = { ...ac2, list: updatedList };
          await sendRequest('config.apply', { raw: JSON.stringify(cfg2, null, 2), baseHash: hash2 });
        } catch { /* ignore */ }
      }

      // 세션 삭제
      try { await sendRequest('sessions.delete', { key: sessionKey, deleteTranscript: true }); } catch { /* ignore */ }

      showMessage('프로필 생성 완료! 설정 반영 중....');
      loadAgents();
      onAgentsChanged();
      await syncAgents();
    } catch (err) {
      showMessage('프로필 생성 중 오류가 발생했습니다. 설정 반영 중...', true);
      await syncAgents();
    } finally {
      setProfileGenerating(false);
      setShowProfileModal(false);
      setProfileInput('');
      setPendingAgentId('');
    }
  };

  // 이름/ID 기반 이모지 자동 매칭
  const autoEmoji = (name: string, id: string): string => {
    const text = `${name} ${id}`.toLowerCase();
    const map: [string[], string][] = [
      [['개발', 'dev', 'code', 'engineer'], '💻'],
      [['기획', 'plan', 'pm', 'product'], '📋'],
      [['리뷰', 'review', 'qa', 'test'], '🔍'],
      [['마케팅', 'market', 'sns', 'growth'], '📢'],
      [['디자인', 'design', 'ui', 'ux'], '🎨'],
      [['데이터', 'data', 'analyst', 'bi'], '📊'],
      [['법무', 'legal', 'law', 'compliance'], '⚖️'],
      [['재무', 'finance', 'accounting', 'budget'], '💰'],
      [['영업', 'sales', 'biz'], '🤝'],
      [['인사', 'hr', 'people', 'recruit'], '👥'],
      [['고객', 'cs', 'support', 'service'], '💬'],
      [['운영', 'ops', 'operation', 'admin'], '⚙️'],
      [['보안', 'security', 'infra'], '🔒'],
      [['콘텐츠', 'content', 'writer', 'blog'], '✍️'],
      [['번역', 'translate', 'lang'], '🌐'],
      [['교육', 'edu', 'train', 'mentor'], '📚'],
      [['연구', 'research', 'r&d'], '🔬'],
      [['총괄', 'ceo', 'cto', 'head', 'lead'], '👔'],
    ];
    for (const [keywords, emoji] of map) {
      if (keywords.some(k => text.includes(k))) return emoji;
    }
    return '🤖';
  };

  const handleCreate = async () => {
    if (!newId.trim() || !newName.trim()) {
      showMessage('ID와 이름은 필수입니다', true);
      return;
    }
    try {
      // 이모지 자동 선택
      const emoji = newEmoji || autoEmoji(newName, newId);

      // Use config.patch to add agent
      const configRes = await sendRequest('config.get', {});
      const configPayload = (configRes as { payload?: Record<string, unknown> }).payload;
      const hash = configPayload?.hash as string;
      const config = configPayload?.config as Record<string, unknown>;
      const agentsConfig = config?.agents as Record<string, unknown> || {};
      const list = (agentsConfig?.list as Array<Record<string, unknown>>) || [];

      const newAgent: Record<string, unknown> = {
        id: newId.trim(),
        name: newName.trim(),
        identity: {
          name: newName.trim(),
          emoji,
        },
      };
      if (newSubagents.length > 0) {
        newAgent.subagents = { allowAgents: newSubagents };
      }

      let updatedList = [...list, newAgent];

      // If a parent is selected, add this agent to the parent's subagents
      if (newParent) {
        updatedList = updatedList.map(a => {
          if ((a as { id: string }).id === newParent) {
            const sub = (a.subagents as Record<string, unknown>) || {};
            const existing = (sub.allowAgents as string[]) || [];
            if (!existing.includes(newId.trim())) {
              return { ...a, subagents: { ...sub, allowAgents: [...existing, newId.trim()] } };
            }
          }
          return a;
        });
      }

      config.agents = { ...agentsConfig, list: updatedList };
      await sendRequest('config.apply', {
        raw: JSON.stringify(config, null, 2),
        baseHash: hash,
      });

      // Auto-update TOOLS.md for agents with subagents
      const allAgents = updatedList.map(a => ({
        id: (a as { id: string }).id,
        name: (a as { name?: string }).name || '',
        identity: (a as { identity?: { name?: string; emoji?: string } }).identity,
        subagents: (a as { subagents?: { allowAgents?: string[] } }).subagents,
      }));
      // If new agent has subagents
      if (newSubagents.length > 0) {
        await updateSubagentTools(newId.trim(), newSubagents, allAgents);
      }
      // If parent was selected, update parent's TOOLS.md
      if (newParent) {
        const parentAgent = allAgents.find(a => a.id === newParent);
        const parentSubs = parentAgent?.subagents?.allowAgents || [];
        if (parentSubs.length > 0) {
          await updateSubagentTools(newParent, parentSubs, allAgents);
        }
      }

      showMessage(`"${newName}" 에이전트가 생성되었습니다.`);
      const createdId = newId.trim();
      setShowCreate(false);
      setNewName(''); setNewEmoji(''); setNewId(''); setNewSubagents([]); setNewParent('');
      loadAgents();
      onAgentsChanged();

      // 프로필 생성 모달 띄우기 (sync는 프로필 완료/건너뛰기 후 실행)
      setPendingAgentId(createdId);
      setProfileInput('');
      setShowProfileModal(true);
    } catch (err) {
      showMessage('에이전트 생성에 실패했습니다', true);
    }
  };

  const handleEdit = async (agentId: string) => {
    try {
      const configRes = await sendRequest('config.get', {});
      const configPayload = (configRes as { payload?: Record<string, unknown> }).payload;
      const hash = configPayload?.hash as string;
      const config = configPayload?.config as Record<string, unknown>;
      const agentsConfig = config?.agents as Record<string, unknown> || {};
      const list = (agentsConfig?.list as Array<Record<string, unknown>>) || [];

      const updatedList = list.map((a) => {
        if ((a as { id: string }).id === agentId) {
          const identity = (a.identity as Record<string, unknown>) || {};
          const updated: Record<string, unknown> = {
            ...a,
            name: editName || (a as { name: string }).name,
            identity: { ...identity, name: editName || identity.name, emoji: editEmoji || identity.emoji },
          };
          if (editSubagents.length > 0) {
            updated.subagents = { allowAgents: editSubagents };
          } else {
            delete updated.subagents;
          }
          return updated;
        }
        return a;
      });

      config.agents = { ...agentsConfig, list: updatedList };
      await sendRequest('config.apply', {
        raw: JSON.stringify(config, null, 2),
        baseHash: hash,
      });

      // Auto-update TOOLS.md if subagents changed
      if (editSubagents.length > 0) {
        const allAgents = updatedList.map(a => ({
          id: (a as { id: string }).id,
          name: (a as { name?: string }).name || '',
          identity: (a as { identity?: { name?: string; emoji?: string } }).identity,
          subagents: (a as { subagents?: { allowAgents?: string[] } }).subagents,
        }));
        await updateSubagentTools(agentId, editSubagents, allAgents);
      }

      showMessage('에이전트가 수정되었습니다. 설정 반영 중....');
      await syncAgents();
      setEditingAgent(null);
      loadAgents();
      onAgentsChanged();
    } catch (err) {
      showMessage('에이전트 수정에 실패했습니다', true);
    }
  };

  const handleDelete = async (agentId: string, agentName: string) => {
    if (!confirm(`"${agentName}" 에이전트를 삭제하시겠습니까?`)) return;
    try {
      const configRes = await sendRequest('config.get', {});
      const configPayload = (configRes as { payload?: Record<string, unknown> }).payload;
      const hash = configPayload?.hash as string;
      const config = configPayload?.config as Record<string, unknown>;
      const agentsConfig = config?.agents as Record<string, unknown> || {};
      const list = (agentsConfig?.list as Array<Record<string, unknown>>) || [];

      const updatedList = list.filter(a => (a as { id: string }).id !== agentId);
      config.agents = { ...agentsConfig, list: updatedList };
      await sendRequest('config.apply', {
        raw: JSON.stringify(config, null, 2),
        baseHash: hash,
      });

      showMessage(`"${agentName}" 에이전트가 삭제되었습니다. 설정 반영 중....`);
      await syncAgents();
      loadAgents();
      onAgentsChanged();
    } catch (err) {
      showMessage('에이전트 삭제에 실패했습니다', true);
    }
  };

  const handleSetDefault = async (agentId: string, agentName: string) => {
    if (!confirm(`"${agentName}"을(를) 기본 에이전트로 설정하시겠습니까?\n디스코드 등 외부 채널에서 이 에이전트가 기본으로 응답합니다.`)) return;
    try {
      const configRes = await sendRequest('config.get', {});
      const configPayload = (configRes as { payload?: Record<string, unknown> }).payload;
      const hash = configPayload?.hash as string;
      const config = configPayload?.config as Record<string, unknown>;
      const agentsConfig = config?.agents as Record<string, unknown> || {};
      const list = (agentsConfig?.list as Array<Record<string, unknown>>) || [];

      const updatedList = list.map(a => ({
        ...a,
        default: (a as { id: string }).id === agentId ? true : undefined,
      }));
      // undefined 필드 제거
      for (const a of updatedList) { if (a.default === undefined) delete a.default; }

      config.agents = { ...agentsConfig, list: updatedList };
      await sendRequest('config.apply', {
        raw: JSON.stringify(config, null, 2),
        baseHash: hash,
      });

      showMessage(`"${agentName}"이(가) 기본 에이전트로 설정되었습니다`);
      loadAgents();
      onAgentsChanged();
    } catch (err) {
      showMessage('기본 에이전트 설정에 실패했습니다', true);
    }
  };

  const loadAgentFiles = async (agentId: string) => {
    if (expandedFiles === agentId) {
      setExpandedFiles(null);
      return;
    }
    try {
      const res = await sendRequest('agents.files.list', { agentId });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      if (payload?.files) {
        setAgentFiles(payload.files as AgentFile[]);
        setExpandedFiles(agentId);
      }
    } catch {
      showMessage('파일 목록을 불러올 수 없습니다', true);
    }
  };

  const openFileEditor = async (agentId: string, fileName: string) => {
    try {
      const res = await sendRequest('agents.files.get', { agentId, name: fileName });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      const file = payload?.file as { content?: string } | undefined;
      setEditingFile({
        agentId,
        name: fileName,
        content: file?.content || '',
      });
    } catch {
      setEditingFile({ agentId, name: fileName, content: '' });
    }
  };

  const saveFile = async () => {
    if (!editingFile) return;
    try {
      await sendRequest('agents.files.set', {
        agentId: editingFile.agentId,
        name: editingFile.name,
        content: editingFile.content,
      });
      showMessage(`${editingFile.name} 저장 완료`);
      setEditingFile(null);
      if (expandedFiles) loadAgentFiles(expandedFiles);
    } catch {
      showMessage('파일 저장에 실패했습니다', true);
    }
  };

  const startEdit = (agent: AgentEntry) => {
    setEditingAgent(agent.id);
    setEditName(agent.identity?.name || agent.name);
    setEditEmoji(agent.identity?.emoji || '');
    setEditSubagents(agent.subagents?.allowAgents || []);
  };

  const toggleSubagent = (list: string[], setList: (v: string[]) => void, id: string) => {
    if (list.includes(id)) {
      setList(list.filter(s => s !== id));
    } else {
      setList([...list, id]);
    }
  };

  const getParentOf = (agentId: string): string | null => {
    for (const a of agents) {
      if (a.subagents?.allowAgents?.includes(agentId)) return a.id;
    }
    return null;
  };

  const getFileGuide = (fileName: string): JSX.Element => {
    const guides: Record<string, JSX.Element> = {
      'AGENTS.md': (
        <div className="space-y-3">
          <div>
            <p className="font-bold text-accent mb-1">AGENTS.md — 시스템 프롬프트</p>
            <p className="text-text-secondary">에이전트의 역할, 성격, 행동 규칙을 정의하는 핵심 파일입니다. 에이전트가 대화할 때 항상 이 내용을 참고합니다.</p>
          </div>
          <div>
            <p className="font-medium text-text-primary mb-1">작성 요령</p>
            <ul className="list-disc pl-4 text-text-secondary space-y-1">
              <li><strong>역할 정의</strong>: "당신은 ~입니다" 형태로 시작</li>
              <li><strong>업무 범위</strong>: 어떤 일을 하고 어떤 일을 하지 않는지 명시</li>
              <li><strong>말투/스타일</strong>: 존댓말, 이모지 사용 여부, 답변 길이 등</li>
              <li><strong>규칙</strong>: 반드시 지켜야 할 사항을 목록으로 정리</li>
            </ul>
          </div>
          <div className="p-3 bg-card rounded-lg">
            <p className="text-xs font-medium text-accent mb-2">예시:</p>
            <pre className="text-xs text-text-secondary whitespace-pre-wrap">{`# 업무 비서

당신은 회사의 업무 비서 봇입니다.

## 역할
- 업무 요청을 분류하고 우선순위를 정합니다
- 회의 일정을 정리하고 알려줍니다
- 이메일 초안을 작성합니다

## 규칙
- 항상 존댓말을 사용합니다
- 답변은 간결하게 핵심만 전달합니다
- 모르는 것은 모른다고 솔직하게 말합니다
- 개인정보는 절대 외부에 공유하지 않습니다`}</pre>
          </div>
        </div>
      ),
      'SOUL.md': (
        <div className="space-y-3">
          <div>
            <p className="font-bold text-accent mb-1">SOUL.md — 에이전트 성격/페르소나</p>
            <p className="text-text-secondary">에이전트의 성격, 말투, 가치관 등 "캐릭터"를 정의합니다. AGENTS.md가 "무엇을 하는지"라면, SOUL.md는 "어떤 존재인지"를 설명합니다.</p>
          </div>
          <div>
            <p className="font-medium text-text-primary mb-1">작성 요령</p>
            <ul className="list-disc pl-4 text-text-secondary space-y-1">
              <li><strong>성격</strong>: 친절한, 전문적인, 유머러스한 등</li>
              <li><strong>말투</strong>: 구체적인 어조와 표현 스타일</li>
              <li><strong>가치관</strong>: 중요하게 생각하는 것</li>
              <li><strong>금기사항</strong>: 절대 하지 않을 행동</li>
            </ul>
          </div>
          <div className="p-3 bg-card rounded-lg">
            <p className="text-xs font-medium text-accent mb-2">예시:</p>
            <pre className="text-xs text-text-secondary whitespace-pre-wrap">{`# 성격
- 밝고 긍정적이며 친절합니다
- 전문적이면서도 딱딱하지 않은 말투를 씁니다
- 사용자의 기분을 배려합니다

# 말투
- "~해드릴게요", "~할까요?" 등 부드러운 표현을 씁니다
- 이모지를 적절히 사용합니다 ✨
- 긴 답변은 제목과 목록으로 구조화합니다

# 가치관
- 정확한 정보 전달을 최우선으로 합니다
- 사용자의 시간을 존중합니다`}</pre>
          </div>
        </div>
      ),
      'IDENTITY.md': (
        <div className="space-y-3">
          <div>
            <p className="font-bold text-accent mb-1">IDENTITY.md — 에이전트 소개</p>
            <p className="text-text-secondary">에이전트가 자기소개를 할 때 참고하는 파일입니다. "너는 누구야?"라고 물었을 때 이 내용을 기반으로 답변합니다.</p>
          </div>
          <div className="p-3 bg-card rounded-lg">
            <p className="text-xs font-medium text-accent mb-2">예시:</p>
            <pre className="text-xs text-text-secondary whitespace-pre-wrap">{`저는 TideClaw의 업무 비서 봇입니다.
회의 일정 관리, 이메일 작성, 업무 정리를 도와드립니다.
궁금한 것이 있으면 언제든 물어보세요!`}</pre>
          </div>
        </div>
      ),
      'MEMORY.md': (
        <div className="space-y-3">
          <div>
            <p className="font-bold text-accent mb-1">MEMORY.md — 기억/메모</p>
            <p className="text-text-secondary">에이전트가 기억해야 할 중요한 정보를 저장합니다. 대화 중 "이거 기억해"라고 하면 여기에 추가됩니다. 직접 편집도 가능합니다.</p>
          </div>
          <div>
            <p className="font-medium text-text-primary mb-1">활용 예시</p>
            <ul className="list-disc pl-4 text-text-secondary space-y-1">
              <li>자주 사용하는 정보 (팀원 이름, 프로젝트명 등)</li>
              <li>사용자의 선호사항 (보고서 형식, 이메일 스타일 등)</li>
              <li>반복적으로 참고해야 할 데이터</li>
            </ul>
          </div>
          <div className="p-3 bg-card rounded-lg">
            <p className="text-xs font-medium text-accent mb-2">예시:</p>
            <pre className="text-xs text-text-secondary whitespace-pre-wrap">{`## 팀 정보
- 팀장: 김철수 (chulsoo@company.com)
- 주간 회의: 매주 월요일 10:00

## 사용자 선호
- 보고서는 표 형식으로 작성
- 이메일은 간결하게, 3문단 이내`}</pre>
          </div>
        </div>
      ),
      'TOOLS.md': (
        <div className="space-y-3">
          <div>
            <p className="font-bold text-accent mb-1">TOOLS.md — 도구 사용 규칙</p>
            <p className="text-text-secondary">에이전트가 사용할 수 있는 도구(명령어, API 등)와 사용 규칙을 정의합니다. 어떤 도구를 어떤 상황에서 쓸지 안내합니다.</p>
          </div>
          <div>
            <p className="font-medium text-text-primary mb-1">작성 요령</p>
            <ul className="list-disc pl-4 text-text-secondary space-y-1">
              <li><strong>허용 도구</strong>: 사용해도 되는 명령어/도구 나열</li>
              <li><strong>금지 도구</strong>: 절대 실행하면 안 되는 것</li>
              <li><strong>사용 조건</strong>: 특정 도구를 쓸 때의 주의사항</li>
            </ul>
          </div>
          <div className="p-3 bg-card rounded-lg">
            <p className="text-xs font-medium text-accent mb-2">예시:</p>
            <pre className="text-xs text-text-secondary whitespace-pre-wrap">{`# 도구 사용 규칙

## 허용
- 웹 검색: 최신 정보 확인 시 사용
- 파일 읽기/쓰기: 문서 작성 시 사용
- 브라우저: 웹사이트 접속이 필요할 때

## 금지
- rm -rf 등 시스템 파일 삭제 명령
- 외부 서버 접속 (허용된 URL 제외)

## 주의사항
- 파일 저장 시 반드시 /home/node/ 하위에 저장
- 대용량 작업 전 사용자에게 확인 받을 것`}</pre>
          </div>
        </div>
      ),
      'USER.md': (
        <div className="space-y-3">
          <div>
            <p className="font-bold text-accent mb-1">USER.md — 사용자 정보</p>
            <p className="text-text-secondary">에이전트가 대화하는 사용자에 대한 정보입니다. 사용자의 직무, 선호사항 등을 미리 알려주면 더 맞춤형 답변을 받을 수 있습니다.</p>
          </div>
          <div className="p-3 bg-card rounded-lg">
            <p className="text-xs font-medium text-accent mb-2">예시:</p>
            <pre className="text-xs text-text-secondary whitespace-pre-wrap">{`# 사용자 정보

## 기본
- 이름: 홍길동
- 직무: 백엔드 개발자
- 팀: 플랫폼팀

## 업무 환경
- 주 사용 언어: TypeScript, Python
- 주 사용 프레임워크: NestJS, FastAPI

## 선호사항
- 코드 설명은 주석보다 별도 설명 선호
- 한국어로 답변
- 간결한 답변 선호`}</pre>
          </div>
        </div>
      ),
      'HEARTBEAT.md': (
        <div className="space-y-3">
          <div>
            <p className="font-bold text-accent mb-1">HEARTBEAT.md — 하트비트 메시지</p>
            <p className="text-text-secondary">에이전트가 주기적으로(하트비트 시) 자동 실행할 작업을 정의합니다. 비어 있으면 하트비트 시 아무 작업도 하지 않습니다.</p>
          </div>
          <div>
            <p className="font-medium text-text-primary mb-1">작성 요령</p>
            <ul className="list-disc pl-4 text-text-secondary space-y-1">
              <li>하트비트마다 봇이 자동으로 이 내용을 읽고 실행합니다</li>
              <li>주기적 체크, 알림, 자동 정리 등에 활용</li>
              <li>비워두면 하트비트가 무시됩니다 (일반적으로 비워둡니다)</li>
            </ul>
          </div>
          <div className="p-3 bg-card rounded-lg">
            <p className="text-xs font-medium text-accent mb-2">예시:</p>
            <pre className="text-xs text-text-secondary whitespace-pre-wrap">{`# 하트비트 작업 (주기적 자동 실행)

이 파일은 보통 비워둡니다.
필요한 경우에만 작성하세요.

## 예시 (사용 시)
- /home/node/gdrive 폴더에 새 파일이 있으면 알려줘
- 오늘 날짜의 메모가 있으면 요약해줘`}</pre>
          </div>
        </div>
      ),
      'BOOTSTRAP.md': (
        <div className="space-y-3">
          <div>
            <p className="font-bold text-accent mb-1">BOOTSTRAP.md — 환경 안내서</p>
            <p className="text-text-secondary">에이전트의 작업 환경(폴더 구조, 사용 가능한 도구, API 정보 등)을 안내하는 파일입니다. 에이전트가 처음 시작할 때 이 파일을 읽고 환경을 파악합니다.</p>
          </div>
          <div>
            <p className="font-medium text-text-primary mb-1">포함 내용</p>
            <ul className="list-disc pl-4 text-text-secondary space-y-1">
              <li><strong>폴더 구조</strong>: 작업 디렉토리, 공유 폴더 경로 등</li>
              <li><strong>사용 가능한 도구</strong>: 브라우저, 이메일, 엑셀 등</li>
              <li><strong>코드 스니펫</strong>: 자주 쓰는 API 호출 코드</li>
              <li><strong>주의사항</strong>: 환경별 제약사항</li>
            </ul>
          </div>
          <div className="p-3 bg-card rounded-lg border border-yellow-500/30">
            <p className="text-xs font-medium text-yellow-400 mb-1">주의: 이 파일은 관리자가 설정한 공유 파일입니다.</p>
            <p className="text-xs text-text-secondary">수정하면 해당 에이전트에만 적용됩니다. 전체 공유 설정은 관리자에게 문의하세요.</p>
          </div>
        </div>
      ),
    };

    return guides[fileName] || (
      <div>
        <p className="font-bold text-accent mb-1">{fileName}</p>
        <p className="text-text-secondary">이 파일에 에이전트가 참고할 내용을 자유롭게 작성하세요. 마크다운 형식을 지원합니다.</p>
      </div>
    );
  };

  const getFilePlaceholder = (fileName: string): string => {
    const placeholders: Record<string, string> = {
      'AGENTS.md': '# 역할\n당신은 ~입니다.\n\n## 업무 범위\n- ...\n\n## 규칙\n- ...',
      'SOUL.md': '# 성격\n- ...\n\n# 말투\n- ...\n\n# 가치관\n- ...',
      'IDENTITY.md': '저는 ~입니다.\n~을 도와드립니다.',
      'MEMORY.md': '## 기억해야 할 정보\n- ...',
      'TOOLS.md': '# 도구 사용 규칙\n\n## 허용\n- ...\n\n## 금지\n- ...',
      'USER.md': '# 사용자 정보\n\n## 기본\n- 이름: \n- 직무: \n\n## 선호사항\n- ...',
      'HEARTBEAT.md': '# 하트비트 작업\n\n이 파일은 보통 비워둡니다.',
      'BOOTSTRAP.md': '# 작업 환경 안내\n\n## 폴더 구조\n- ...\n\n## 사용 가능한 도구\n- ...',
    };
    return placeholders[fileName] || '내용을 입력하세요...';
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-text-secondary">불러오는 중...</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-text-primary">에이전트 관리</h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm transition-colors"
        >
          <Plus className="w-4 h-4" />
          새 에이전트
        </button>
      </div>

      {error && <div className="px-4 py-2 bg-red-500/20 text-red-400 rounded-lg text-sm">{error}</div>}
      {success && <div className="px-4 py-2 bg-green-500/20 text-green-400 rounded-lg text-sm">{success}</div>}

      {/* Create Form */}
      {showCreate && (
        <div className="bg-card border border-border-color rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-medium text-text-primary">새 에이전트 만들기</h3>
          <div className="grid grid-cols-3 gap-3">
            <input
              value={newId}
              onChange={e => setNewId(e.target.value.replace(/[^a-z0-9-]/g, ''))}
              placeholder="ID (영문소문자)"
              className="px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
            />
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="이름"
              className="px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
            />
            <input
              value={newEmoji}
              onChange={e => setNewEmoji(e.target.value)}
              placeholder="이모지 (선택)"
              className="px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
              maxLength={2}
            />
          </div>
          {/* 상위/서브 에이전트는 sync-agents.sh가 자동 관리 (비서=루트, 나머지=하위) */}
          <div className="flex gap-2">
            <button onClick={handleCreate} className="flex items-center gap-1 px-4 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent-hover">
              <Save className="w-3 h-3" /> 생성
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-text-secondary hover:text-text-primary text-sm">
              취소
            </button>
          </div>
        </div>
      )}

      {/* Agent List — hide -discord agents */}
      {agents.filter(a => !a.id.endsWith('-discord')).map(agent => (
        <div key={agent.id} className="bg-card border border-border-color rounded-xl overflow-hidden">
          <div className="p-4">
            {editingAgent === agent.id ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    placeholder="이름"
                    className="px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
                  />
                  <input
                    value={editEmoji}
                    onChange={e => setEditEmoji(e.target.value)}
                    placeholder="이모지"
                    className="px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
                    maxLength={2}
                  />
                </div>
                {/* Sub-agents managed automatically by sync-agents.sh */}
                <div className="flex gap-2">
                  <button onClick={() => handleEdit(agent.id)} className="flex items-center gap-1 px-3 py-1.5 bg-accent text-white rounded-lg text-sm hover:bg-accent-hover">
                    <Save className="w-3 h-3" /> 저장
                  </button>
                  <button onClick={() => setEditingAgent(null)} className="flex items-center gap-1 px-3 py-1.5 text-text-secondary hover:text-text-primary text-sm">
                    <X className="w-3 h-3" /> 취소
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{agent.identity?.emoji || '🤖'}</span>
                  <div>
                    <p className="font-medium text-text-primary">{agent.identity?.name || agent.name}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-text-secondary">ID: {agent.id}</p>
                      {agent.default && (
                        <span className="text-xs px-1.5 py-0.5 bg-emerald-500/20 text-emerald-400 rounded font-medium">팀장</span>
                      )}
                      {agents.some(a => a.id === agent.id + '-discord') && (
                        <span className="text-xs px-1.5 py-0.5 bg-indigo-500/20 text-indigo-400 rounded font-medium">💬 디스코드</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => loadAgentFiles(agent.id)}
                    className="p-2 text-text-secondary hover:text-text-primary hover:bg-background rounded-lg transition-colors"
                    title="시스템 프롬프트/파일"
                  >
                    {expandedFiles === agent.id ? <ChevronUp className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => startEdit(agent)}
                    className="p-2 text-text-secondary hover:text-accent hover:bg-background rounded-lg transition-colors"
                    title="수정"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  {!agent.default && (
                    <button
                      onClick={() => handleDelete(agent.id, agent.identity?.name || agent.name)}
                      className="p-2 text-text-secondary hover:text-red-400 hover:bg-background rounded-lg transition-colors"
                      title="삭제"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Agent Files */}
          {expandedFiles === agent.id && (
            <div className="border-t border-border-color p-4 bg-background/50 space-y-2">
              <p className="text-xs text-text-secondary font-medium mb-2">에이전트 파일 (시스템 프롬프트 등)</p>
              {agentFiles.map(file => (
                <button
                  key={file.name}
                  onClick={() => openFileEditor(agent.id, file.name)}
                  className="w-full text-left flex items-center justify-between px-3 py-2 rounded-lg hover:bg-card transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-text-secondary" />
                    <span className="text-sm text-text-primary">{file.name}</span>
                  </div>
                  <span className="text-xs text-text-secondary">
                    {file.missing ? '없음 (클릭하여 생성)' : `${file.size || 0}B`}
                  </span>
                </button>
              ))}
              <button
                onClick={() => openFileEditor(agent.id, 'AGENTS.md')}
                className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-card transition-colors text-accent text-sm"
              >
                <Plus className="w-4 h-4" />
                시스템 프롬프트 편집 (AGENTS.md)
              </button>
            </div>
          )}
        </div>
      ))}

      {/* File Editor Modal */}
      {editingFile && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border-color rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-border-color">
              <div>
                <h3 className="font-medium text-text-primary">{editingFile.name}</h3>
                <p className="text-xs text-text-secondary">에이전트: {editingFile.agentId}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowGuide(prev => !prev)}
                  className="px-3 py-1.5 text-xs bg-background border border-border-color rounded-lg text-text-secondary hover:text-accent transition-colors"
                >
                  {showGuide ? '가이드 닫기' : '작성 가이드'}
                </button>
                <button onClick={() => setEditingFile(null)} className="p-2 text-text-secondary hover:text-text-primary">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Writing Guide */}
            {showGuide && (
              <div className="p-4 border-b border-border-color bg-background/50 overflow-y-auto max-h-[40vh] space-y-4 text-sm">
                {getFileGuide(editingFile.name)}
              </div>
            )}

            <textarea
              value={editingFile.content}
              onChange={e => setEditingFile({ ...editingFile, content: e.target.value })}
              className="flex-1 p-4 bg-background text-text-primary text-sm font-mono resize-none focus:outline-none min-h-[250px]"
              placeholder={getFilePlaceholder(editingFile.name)}
            />
            <div className="flex justify-end gap-2 p-4 border-t border-border-color">
              <button onClick={() => setEditingFile(null)} className="px-4 py-2 text-text-secondary hover:text-text-primary text-sm">
                취소
              </button>
              <button onClick={saveFile} className="flex items-center gap-1 px-4 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent-hover">
                <Save className="w-4 h-4" /> 저장
              </button>
            </div>
          </div>
        </div>
      )}
      {/* AI 프로필 생성 모달 */}
      {showProfileModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => { if (!profileGenerating) { setShowProfileModal(false); } }} />
          <div className="relative bg-card border border-border-color rounded-2xl shadow-2xl w-full max-w-lg mx-4 p-6">
            {profileGenerating ? (
              <div className="flex flex-col items-center py-8">
                <div className="w-12 h-12 border-3 border-accent border-t-transparent rounded-full animate-spin mb-4" />
                <h3 className="text-lg font-bold text-text-primary mb-2">AI가 프로필을 생성하고 있습니다</h3>
                <p className="text-sm text-text-secondary text-center">SOUL.md, IDENTITY.md 등을 자동으로 작성 중입니다...<br />최대 30초 정도 소요됩니다.</p>
              </div>
            ) : (
              <>
                <h3 className="text-lg font-bold text-text-primary mb-2">에이전트 프로필 설정</h3>
                <p className="text-sm text-text-secondary mb-4">
                  이 에이전트의 역할, 성격, 전문 분야를 자유롭게 설명해주세요.<br />
                  AI가 자동으로 시스템 프롬프트 파일을 생성합니다.
                </p>
                <textarea
                  value={profileInput}
                  onChange={(e) => setProfileInput(e.target.value)}
                  placeholder={"예시:\n- 마케팅 전문가, SNS 콘텐츠 기획에 능함\n- 친근하고 유쾌한 말투\n- 데이터 기반으로 분석하고 제안함\n- 타겟: 20-30대 직장인"}
                  className="w-full h-40 px-4 py-3 bg-background border border-border-color rounded-xl text-text-primary text-sm resize-none focus:outline-none focus:border-accent placeholder-text-secondary"
                  autoFocus
                />
                <div className="flex items-center justify-between mt-4">
                  <button
                    onClick={() => { setShowProfileModal(false); setProfileInput(''); showMessage('설정 반영 중....'); syncAgents(); }}
                    className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
                  >
                    건너뛰기
                  </button>
                  <button
                    onClick={() => {
                      if (profileInput.trim()) {
                        generateAgentProfile(pendingAgentId, profileInput.trim());
                      } else {
                        showMessage('설명을 입력해주세요', true);
                      }
                    }}
                    disabled={!profileInput.trim()}
                    className="px-5 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    AI로 생성
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
