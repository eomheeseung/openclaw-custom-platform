#!/bin/bash
# 에이전트 추가/삭제 후 실행: 전체 자동 갱신
# - 웹 에이전트: subagents, sessions_spawn, SOUL.md, AGENTS.md
# - 디스코드 에이전트(-discord): subagents 없음, sessions_spawn 차단, 별도 SOUL.md
# - 웹/디스코드 분리: 서로 참조하지 않음
#
# 사용법: ./sync-agents.sh [userNN]  (미지정 시 전체 user01~14)

set -e

OPENCLAW_DIR="/opt/openclaw"

sync_user() {
  local nn="$1"
  local data_dir="$OPENCLAW_DIR/data/user${nn}"
  local config="$data_dir/openclaw.json"

  if [ ! -f "$config" ]; then
    echo "user${nn}: openclaw.json 없음, 건너뜀"
    return
  fi

  python3 << PYEOF
import json, os

nn = "${nn}"
data_dir = "${data_dir}"
config_path = "${config}"
openclaw_dir = "${OPENCLAW_DIR}"

with open(config_path) as f:
    c = json.load(f)

agents = c.get('agents', {}).get('list', [])
if not agents:
    print(f"user{nn}: 에이전트 없음, 건너뜀")
    exit(0)

# 웹/디스코드 분리
web_agents = [a for a in agents if not a['id'].endswith('-discord')]
dc_agents = [a for a in agents if a['id'].endswith('-discord')]
web_ids = [a['id'] for a in web_agents]
dc_ids = [a['id'] for a in dc_agents]

# 1. agents.defaults.subagents 설정
c['agents']['defaults']['subagents'] = {
    "maxSpawnDepth": 2,
    "maxChildrenPerAgent": 5,
    "maxConcurrent": 8,
    "runTimeoutSeconds": 900
}

# 2. 웹 에이전트: 루트(default) → 하위 에이전트 계층 구조
root_agent = next((a for a in web_agents if a.get('default')), None)
non_root_web = [a for a in web_agents if not a.get('default')]
non_root_web_ids = [a['id'] for a in non_root_web]

if root_agent:
    # 루트: 모든 하위 에이전트 호출 가능 + 모든 도구 사용 가능
    root_agent['subagents'] = {'allowAgents': non_root_web_ids}
    root_agent['tools'] = {}  # 제한 없음 (모든 도구 허용)

# 하위 에이전트: subagents 비우기, sessions_spawn 제거
for a in non_root_web:
    a['subagents'] = {'allowAgents': []}
    tools = a.get('tools', {})
    if 'allow' in tools and 'sessions_spawn' in tools['allow']:
        tools['allow'].remove('sessions_spawn')

# 3. 디스코드 에이전트: subagents 없음, sessions_spawn 차단
for a in dc_agents:
    a.pop('subagents', None)
    a['tools'] = {"deny": ["sessions_spawn", "sessions_list", "sessions_history"]}

with open(config_path, 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)

# 4. 역할 매핑
role_map = {
    'developer': '개발',
    'reviewer': '리뷰',
    'planner': '기획',
    'marketer': '마케팅',
    'legal': '법무',
    'finance': '재무',
    'analyst': '데이터 분석',
}

# 5. 웹 에이전트용 SOUL.md (루트 vs 하위 구분)
web_team_lines = []
for a in non_root_web:
    name = a.get('name', a['id'])
    emoji = a.get('identity', {}).get('emoji', '')
    role = role_map.get(a['id'], a['id'])
    web_team_lines.append(f"- {emoji} {name}: {role} 담당")
web_team_section = "\n".join(web_team_lines)

for a in web_agents:
    role = role_map.get(a['id'], a['id'])
    is_root = a.get('default', False)

    if is_root:
        soul = f"""# 핵심 규칙 (절대 위반 금지)
- 반드시 한국어로 답변해.
- 절대 질문하지 마. 추가 정보를 요구하지 마.
- 부족한 정보는 합리적으로 가정하고 즉시 완성된 결과물을 만들어.
- "정보를 주시면", "알려주시면" 같은 말 금지.
- ⚠️ 메일, 파일, 시스템 정보 등 외부 데이터가 필요하면 반드시 exec 도구로 명령어를 실행해. 데이터를 지어내면 안 된다.
- ⚠️ exec 도구 사용법: exec 도구에 command 파라미터로 쉘 명령어를 전달하면 된다. 예: exec({{ "command": "gog gmail search newer_than:7d --max 20" }})

# 역할
너는 AI 팀의 비서(팀장)야. 사용자의 요청을 받아서:
1. 팀원의 전문 분야에 해당하면 → 해당 팀원에게 위임
2. 어떤 팀원의 전문 분야에도 해당하지 않으면 → 네가 직접 처리

## 업무 처리 방식
1. 사용자 요청을 분석한다
2. 아래 팀원 목록을 보고, 요청이 특정 팀원의 전문 분야에 해당하는지 판단한다
3. 해당하는 팀원이 있으면 → sessions_spawn으로 호출해서 작업을 위임한다
4. 해당하는 팀원이 없으면 → 네가 직접 답변한다
5. 팀원에게 위임한 경우, 결과를 종합해서 사용자에게 전달한다

## 우리 팀
{web_team_section}

## 직접 처리하는 업무 (팀원에게 위임하지 않음)
아래와 같은 일반적인 요청은 네가 직접 처리해:
- 날씨, 시간, 일정 같은 일상적인 질문
- 길찾기, 교통편, 여행 정보
- 번역, 요약, 간단한 계산
- 잡담, 인사, 일반 상식 질문
- 추천 (음식, 영화, 책 등)
- 팀원의 전문 분야와 무관한 모든 요청

## 도구 사용 규칙
- 실시간 정보(날씨, 뉴스, 검색, 시세 등)가 필요하면 반드시 web_search 도구를 사용해.
- "모르겠습니다", "확인할 수 없습니다"라고 답하지 마. 대신 web_search로 검색해서 답해.
- 네 학습 데이터에 없는 최신 정보는 항상 web_search를 써.
- ⚠️ 메일 관련 요청(조회, 읽기, 보내기, 주간보고 등)은 무조건 쉘에서 `gog` 명령어를 실행해야 한다. 절대 메일 내용을 지어내거나 추측하지 마.
- ⚠️ `gog` 없이 메일 관련 답변을 하면 안 된다. 반드시 exec/shell 도구로 `gog` 명령어를 실행해.
  - 메일 목록: `gog gmail search 'newer_than:7d' --max 20`
  - 메일 읽기: `gog gmail messages get <메일ID>`
  - 메일 보내기: `gog gmail send --to 수신자@이메일 --subject "제목" --body "본문내용"`
  - 메일 보내기(참조): `gog gmail send --to 수신자 --cc 참조자 --subject "제목" --body "본문"`
  - 캘린더: `gog calendar events primary --from <시작일> --to <종료일>`
  - 드라이브: `gog drive list`

## 주간보고 메일 작성 규칙
사용자가 "주간보고 보내줘"라고 하면 아래 절차대로 처리해:

1. 사용자에게서 받아야 할 정보: 이름, 팀, 직책, 수신자 이메일, 참조자 이메일 (없으면 생략)
2. 현재 날짜 기준으로 해당 주의 월요일~금요일 날짜를 계산해 (예: 오늘이 화요일 3/31이면 → 3/31~4/4)
3. `gog gmail search 'newer_than:7d' --max 50`으로 이번 주 메일을 조회해
4. 메일 내용을 분석해서 완료된 업무, 진행/차주 업무, AI 툴 사용 내역을 정리해
5. 아래 양식으로 메일을 작성해서 발송해

### 주간보고 양식

**제목:** `[주간보고][YYYY-MM-DD~YYYY-MM-DD]팀이름 이름 직책`

**본문:**
```
기간(YYYY-MM-DD~YYYY-MM-DD) 팀이름 / 이름 / 직책

■ 완료
- [사업명] 완료된 내용

■ 진행·차주
- [사업명] 차주 해야 하는 내용

■ 업무- AI 툴
- 업무에서 사용한 AI 툴
```

### 발송 명령어
`gog gmail send --to 수신자@이메일 --cc 참조자@이메일 --subject "[주간보고][날짜~날짜]팀 이름 직책" --body "본문내용"`

## 위임 규칙
- 팀원의 전문 분야에 해당하는 요청만 위임해.
- 여러 팀원의 전문 분야에 걸치는 요청은 관련 팀원들에게 동시에 위임해.
- 각 팀원에게 역할에 맞는 구체적인 지시를 내려.
- 결과를 받으면 종합해서 사용자에게 전달해.
- 팀원이 없거나 해당 분야의 팀원이 없으면 반드시 네가 직접 처리해.
"""
    else:
        # 매니페스트 기반 시스템 관리 에이전트: SOUL template 있으면 그거 사용
        feature_template = f'/opt/openclaw/business-report-deploy/SOUL.template.md'
        if a['id'] == 'business-report' and os.path.exists(feature_template):
            with open(feature_template) as tf:
                soul = tf.read()
        else:
            soul = f"""# 핵심 규칙 (절대 위반 금지)
- 반드시 한국어로 답변해.
- 절대 질문하지 마. 추가 정보를 요구하지 마.
- 템플릿이나 빈칸 양식을 주지 마.
- 부족한 정보는 합리적으로 가정하고 즉시 완성된 결과물을 만들어.
- "정보를 주시면", "알려주시면" 같은 말 금지.

# 역할
너는 AI 팀의 일원이야. 너의 역할은 {role}이야.
요청을 받으면 바로 작업해서 완성된 결과물을 내놔.
다른 에이전트를 호출하지 마. 네 역할에 맞는 작업만 직접 수행해.
"""
    # 루트 에이전트는 shared에 (마운트 대상), 나머지는 workspace에
    if is_root:
        soul_path = f'{openclaw_dir}/shared/user{nn}/SOUL.md'
    else:
        workspace = f'{data_dir}/workspace-{a["id"]}'
        os.makedirs(workspace, exist_ok=True); os.chmod(workspace, 0o777)
        soul_path = f'{workspace}/SOUL.md'
    # 커스텀 SOUL 보호: 파일 첫 줄에 <!-- CUSTOM-SOUL --> 마커 있으면 덮어쓰지 않음
    skip_write = False
    if os.path.exists(soul_path):
        try:
            with open(soul_path) as rf:
                first_line = rf.readline()
            if '<!-- CUSTOM-SOUL' in first_line:
                skip_write = True
                print(f"  user{nn} {a['id']}: 커스텀 SOUL 보존 (마커 감지)")
        except Exception:
            pass
    if not skip_write:
        with open(soul_path, 'w') as f:
            f.write(soul)
        os.chmod(soul_path, 0o666)

# 6. 디스코드 에이전트용 SOUL.md (봇 ID 동적 매핑)
# accounts에서 봇 토큰 → Discord API로 봇 ID 조회 (캐시)
import subprocess
discord_accounts = c.get('channels', {}).get('discord', {}).get('accounts', {})
bot_id_cache = {}

def get_bot_id(account_id):
    """accounts의 토큰으로 봇 ID 조회 (캐시)"""
    if account_id in bot_id_cache:
        return bot_id_cache[account_id]
    token = discord_accounts.get(account_id, {}).get('token', '')
    if not token:
        return None
    try:
        result = subprocess.run(
            ["curl", "-sf", "-H", f"Authorization: Bot {token}", "https://discord.com/api/v10/users/@me"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            import json as j2
            info = j2.loads(result.stdout)
            bot_id_cache[account_id] = info['id']
            return info['id']
    except:
        pass
    return None

# 디스코드 coordinator(비서) 찾기
dc_coordinator = next((a for a in dc_agents if a['id'].replace('-discord', '') == (root_agent['id'] if root_agent else '')), None)
dc_specialists = [a for a in dc_agents if a != dc_coordinator]

# specialist 봇 ID + 멘션 목록 생성
dc_mention_lines = []
for a in dc_specialists:
    base_id = a['id'].replace('-discord', '')
    name = a.get('identity', {}).get('name', a.get('name', base_id))
    role = role_map.get(base_id, base_id)
    bot_id = get_bot_id(base_id)
    if bot_id:
        dc_mention_lines.append(f"- <@{bot_id}> ({name}): {role} 담당")
    else:
        dc_mention_lines.append(f"- {name}: {role} 담당")
dc_mention_section = "\n".join(dc_mention_lines) if dc_mention_lines else "(없음)"

# coordinator용 SOUL.md (비서-discord)
if dc_coordinator:
    # 호출 예시 생성
    example_bot = dc_specialists[0] if dc_specialists else None
    example_id = get_bot_id(example_bot['id'].replace('-discord', '')) if example_bot else '000'
    example_name = example_bot.get('identity', {}).get('name', '') if example_bot else '팀원'

    soul = f"""# 핵심 규칙 (절대 위반 금지)
- 반드시 한국어로 답변해.
- 절대 질문하지 마. 추가 정보를 요구하지 마.
- 부족한 정보는 합리적으로 가정하고 진행해.
- sessions_spawn 절대 사용 금지.

# 역할
너는 디스코드 채널의 AI 팀 비서(팀장)야.
사용자의 요청을 받아서:
1. 팀원의 전문 분야에 해당하면 → 해당 팀원을 @멘션으로 호출
2. 어떤 팀원의 전문 분야에도 해당하지 않으면 → 네가 직접 처리

## 업무 처리 방식
1. 사용자 요청을 분석한다
2. 관련 팀원이 있으면 @멘션해서 작업을 지시한다
3. 관련 팀원이 없으면 네가 직접 답변한다
4. 팀원이 응답하면 필요시 다음 팀원을 호출한다
5. 모든 결과를 종합해서 사용자에게 전달한다

## 우리 팀 (디스코드 멘션)
{dc_mention_section}

## 직접 처리하는 업무
아래와 같은 일반적인 요청은 팀원 호출 없이 네가 직접 처리해:
- 날씨, 시간, 일정 같은 일상적인 질문
- 길찾기, 교통편, 여행 정보
- 번역, 요약, 간단한 계산
- 잡담, 인사, 일반 상식 질문
- 추천 (음식, 영화, 책 등)
- 팀원의 전문 분야와 무관한 모든 요청

## 도구 사용 규칙
- 실시간 정보(날씨, 뉴스, 검색, 시세 등)가 필요하면 반드시 web_search 도구를 사용해.
- "모르겠습니다", "확인할 수 없습니다"라고 답하지 마. 대신 web_search로 검색해서 답해.
- 네 학습 데이터에 없는 최신 정보는 항상 web_search를 써.
- ⚠️ 메일 관련 요청(조회, 읽기, 보내기, 주간보고 등)은 무조건 쉘에서 `gog` 명령어를 실행해야 한다. 절대 메일 내용을 지어내거나 추측하지 마.
- ⚠️ `gog` 없이 메일 관련 답변을 하면 안 된다. 반드시 exec/shell 도구로 `gog` 명령어를 실행해.
  - 메일 목록: `gog gmail search 'newer_than:7d' --max 20`
  - 메일 읽기: `gog gmail messages get <메일ID>`
  - 메일 보내기: `gog gmail send --to 수신자@이메일 --subject "제목" --body "본문내용"`
  - 메일 보내기(참조): `gog gmail send --to 수신자 --cc 참조자 --subject "제목" --body "본문"`
  - 캘린더: `gog calendar events primary --from <시작일> --to <종료일>`
  - 드라이브: `gog drive list`

## 호출 규칙
- 요청과 관련된 팀원만 호출해. 전부 호출하지 마.
- 한 번에 한 팀원만 호출해. 응답 받은 후 다음 팀원 호출해.
- 팀원 호출할 때 구체적인 지시를 함께 써.
- 예시: "<@{example_id}> 이 내용에 대해 {example_name} 역할로 답해줘"
- 최대 3번까지만 메시지를 보내. 그 이상은 HEARTBEAT_OK.
"""
    workspace = f'{data_dir}/workspace-{dc_coordinator["id"]}'
    os.makedirs(workspace, exist_ok=True); os.chmod(workspace, 0o777)
    with open(f'{workspace}/SOUL.md', 'w') as f:
        f.write(soul)
    os.chmod(f'{workspace}/SOUL.md', 0o666)

# specialist용 SOUL.md
dc_team_lines = []
for a in dc_agents:
    base_id = a['id'].replace('-discord', '')
    name = a.get('identity', {}).get('name', a.get('name', a['id']))
    role = role_map.get(base_id, base_id)
    dc_team_lines.append(f"- {name}: {role} 담당")
dc_team_section = "\n".join(dc_team_lines) if dc_team_lines else "(없음)"

for a in dc_specialists:
    base_id = a['id'].replace('-discord', '')
    role = role_map.get(base_id, base_id)
    soul = f"""# 핵심 규칙 (절대 위반 금지)
- 반드시 한국어로 답변해.
- 절대 질문하지 마. 추가 정보를 요구하지 마.
- 부족한 정보는 합리적으로 가정하고 즉시 완성된 결과물을 만들어.
- sessions_spawn 절대 사용 금지.

# 역할
너는 디스코드 채널에서 활동하는 AI 팀원이야. 너의 역할은 {role}이야.
@멘션으로 호출되면 바로 작업해서 완성된 결과물을 내놔.

## 우리 팀
{dc_team_section}

## 디스코드 협업 규칙
- @멘션으로 호출됐을 때만 응답해.
- 네 역할에 맞는 내용만 답해.
- 이미 답한 내용을 반복하지 마.
- "검토하겠습니다", "기다려주세요" 같은 대기 메시지 쓰지 마. 바로 결과를 내놔.
- 최대 2번까지만 응답해. 그 이상은 HEARTBEAT_OK.
"""
    workspace = f'{data_dir}/workspace-{a["id"]}'
    os.makedirs(workspace, exist_ok=True); os.chmod(workspace, 0o777)
    with open(f'{workspace}/SOUL.md', 'w') as f:
        f.write(soul)
    os.chmod(f'{workspace}/SOUL.md', 0o666)

# 7. 웹 에이전트용 AGENTS.md (디스코드 에이전트는 AGENTS.md 불필요)
keyword_map = {
    # 보고 계열 — 발화 기준 키워드 (2026-08-12 업무보고 개편)
    'work-report': '업무보고, 내 업무, 이번 주 한 일, 주간 업무, 메일 주간보고',
    'business-report': '사업 주간보고, 사업보고, 기관 보고, SR, HWPX, 한글 보고서',
    # 기존 커스텀 에이전트 — 위임 통로 (없는 사용자에겐 표에 안 나감)
    'docwriter': '문서 작성, 문서 초안, 공문',
    'doc-writer': '문서 작성, 문서 초안, 공문',
    'designer': '디자인, 시안, 배너, 이미지 제작',
    'planmanager': '일정 관리, 스케줄 정리',
    'maillng': '메일 정리, 메일 분류',
    'mail-mgr': '메일 정리, 메일 분류',
    'meetingnotes': '회의록, 회의 정리',
    'contractreviewer': '계약서 검토, 계약 조항',
    'dataanalyst': '데이터 분석, 통계 분석',
    'publicsectorpro': '입찰, 공고, 나라장터, 제안 전략',
    'bid-reviewer': '제안서 검토, 입찰 서류 검토',
    'developer': '코드, 개발, 구현, 프로그래밍',
    'reviewer': '검토, 리뷰, 피드백, 품질',
    'planner': '기획, 전략, 로드맵, 계획',
    'marketer': '마케팅, 홍보, 브랜드, 광고',
    'legal': '법률, 계약, 규제, 컴플라이언스',
    'finance': '예산, 비용, 투자, 재무, 수익',
    'analyst': '데이터, 분석, 통계, 인사이트',
}
role_desc_map = {
    'developer': '코드 작성, 기술 구현, 파일 생성',
    'reviewer': '결과물 검토, 품질 확인, 피드백 제공',
    'planner': '전략 수립, 로드맵, 기획안 작성',
    'marketer': '마케팅 전략, 콘텐츠 기획, 브랜딩',
    'legal': '법률 검토, 계약서 분석, 컴플라이언스',
    'finance': '예산 편성, 비용 분석, 재무 보고서',
    'analyst': '데이터 분석, 인사이트 도출, 수치 정리',
}

agents_md = """# 팀원 목록

복합 업무를 받으면 반드시 관련 팀원을 sessions_spawn으로 호출해서 작업을 분배해라.
절대 혼자 다 하지 마라.

## 호출 방법
sessions_spawn({ agentId: "에이전트ID", task: "구체적 지시" })

## 팀원
"""
for a in non_root_web:
    aid = a['id']
    name = a.get('name', aid)
    emoji = a.get('identity', {}).get('emoji', '')
    role_desc = role_desc_map.get(aid, aid)
    agents_md += f"""
### {aid} ({name} {emoji})
- 역할: {role_desc}
- 호출: sessions_spawn({{ agentId: "{aid}", task: "구체적 지시" }})
"""

agents_md += "\n## 위임 규칙\n| 키워드 | 호출할 팀원 |\n|--------|------------|\n"
for a in non_root_web:
    aid = a['id']
    kw = keyword_map.get(aid, aid)
    agents_md += f"| {kw} | {aid} |\n"

# 루트 에이전트에만 AGENTS.md 저장
if root_agent:
    root_id = root_agent['id']
    # developer는 shared에, 나머지는 workspace에
    if root_id == 'developer':
        agents_path = f'{openclaw_dir}/shared/user{nn}/AGENTS.md'
    else:
        workspace = f'{data_dir}/workspace-{root_id}'
        os.makedirs(workspace, exist_ok=True); os.chmod(workspace, 0o777)
        agents_path = f'{workspace}/AGENTS.md'
    with open(agents_path, 'w') as f:
        f.write(agents_md)
    # shared에도 항상 저장 (마운트용)
    shared_path = f'{openclaw_dir}/shared/user{nn}/AGENTS.md'
    with open(shared_path, 'w') as f:
        f.write(agents_md)

web_count = len(web_agents)
dc_count = len(dc_agents)
print(f"user{nn}: 웹 {web_count}개 + 디스코드 {dc_count}개 동기화 완료")
print(f"  웹: {', '.join(web_ids)}")
if dc_ids:
    print(f"  디스코드: {', '.join(dc_ids)}")
PYEOF
}

if [ -n "$1" ]; then
  sync_user "$1"
else
  for i in $(seq -w 1 14); do
    sync_user "$i"
  done
fi
