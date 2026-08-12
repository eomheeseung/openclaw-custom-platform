import type { Agent } from '../types';

/* 자연어 문장을 보고 담당 에이전트를 골라 멘션을 붙인다.

   왜 화면에서 하나: 비서에게 맡기면 위임까지는 하는데 **결과를 자기 말로 다시 쓴다**
   (실측 — 카드가 마크다운 표로 바뀌고 소속·수신자를 지어냈다). BOOTSTRAP 최상단에
   "그대로 전달해라" 를 넣어도 지키지 않았다. 라우팅을 규칙으로 옮기면 매번 같게 동작한다.

   왜 이름 매칭인가: 키워드 표를 따로 두면 에이전트가 생길 때마다 관리해야 한다.
   에이전트 이름이 곧 사람들이 쓰는 말이므로("사업 주간보고 작성해줘") 등록 없이 걸린다.
   이름으로 안 잡히는 말투만 agents.list[].aliases 로 보완한다. */

const norm = (s: string) => s.toLowerCase().replace(/[\s()[\]·・,.\-_/]+/g, '');

/** 이름에서 괄호 설명을 떼어 낸 핵심부. "사업 주간보고 (기관 제출용)" → "사업 주간보고" */
function nameCore(name: string): string {
  return name.replace(/[(（].*?[)）]/g, '').trim();
}

function candidates(agent: Agent): string[] {
  const out = [nameCore(agent.name), agent.name, ...(agent.aliases || [])];
  return out.map(x => (x || '').trim()).filter(x => x.length >= 2);
}

/**
 * 문장에 담당 에이전트 이름/별칭이 들어 있으면 그 에이전트를 돌려준다.
 * - 이미 멘션이 있으면 건드리지 않는다
 * - 기본 에이전트(비서)는 대상이 아니다 — 아무 말에나 걸리면 안 된다
 * - 여러 개가 걸리면 **가장 길게 일치한 것** (더 구체적인 이름이 이긴다:
 *   "사업 주간보고" 가 "주간보고" 보다 우선)
 */
export function resolveAgentFor(text: string, agents: Agent[]): Agent | null {
  const t = (text || '').trim();
  if (!t || t.startsWith('@')) return null;
  const flat = norm(t);
  let best: Agent | null = null;
  let bestLen = 0;
  for (const agent of agents) {
    if (agent.default) continue;
    for (const c of candidates(agent)) {
      const key = norm(c);
      if (key.length >= 2 && flat.includes(key) && key.length > bestLen) {
        best = agent;
        bestLen = key.length;
      }
    }
  }
  return best;
}

/** 담당이 잡히면 멘션을 앞에 붙인 문장을, 아니면 원문 그대로 돌려준다. */
export function withAgentMention(text: string, agents: Agent[]): string {
  const agent = resolveAgentFor(text, agents);
  return agent ? `@${agent.id} ${text}` : text;
}
