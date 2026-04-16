import { X, MessageSquare, Bot, Clock, Network, Settings, HelpCircle, LayoutDashboard, Workflow, Link, Radio } from 'lucide-react';

interface HelpModalProps {
  onClose: () => void;
}

export function HelpModal({ onClose }: HelpModalProps) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border-color rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border-color">
          <div className="flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-accent" />
            <h2 className="text-lg font-bold text-text-primary">사용 가이드</h2>
          </div>
          <button onClick={onClose} className="p-2 text-text-secondary hover:text-text-primary transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* Dashboard */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <LayoutDashboard className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">대시보드</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>에이전트별 최근 활동, 실행 중인 작업, 전체 상태를 한눈에 확인합니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>각 에이전트 카드를 클릭하면 해당 에이전트와 채팅으로 이동합니다.</li>
                <li>실행 중인 Cron·세션 현황이 실시간으로 표시됩니다.</li>
              </ul>
            </div>
          </section>

          {/* Chat */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">채팅</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>AI 에이전트와 대화하는 메인 화면입니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>Enter로 전송, Shift+Enter로 줄바꿈합니다.</li>
                <li>클립 아이콘으로 파일을 첨부할 수 있습니다.</li>
                <li><strong>@멘션</strong>: 메시지에 <code className="text-accent">@에이전트명</code>을 입력하면 해당 에이전트를 호출합니다.</li>
                <li>좌측 사이드바 상단 <strong>+</strong> 버튼으로 새 대화를 시작합니다.</li>
                <li>사이드바의 이전 대화를 클릭하면 히스토리를 확인할 수 있습니다.</li>
              </ul>
            </div>
          </section>

          {/* Workflow */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Workflow className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">워크플로 (입찰 관리)</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>입찰공고를 빠르게 조회·분석하는 전용 화면입니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li><strong>오늘 배정 요약</strong>: 배정된 입찰공고 전체를 자동 요약합니다. 상세 수준(정상/상세/초상세) 선택 가능.</li>
                <li><strong>특정 사업 상세</strong>: 사업명을 입력하면 해당 입찰건의 RFP 원문 기반 상세 리포트를 생성합니다.</li>
                <li><strong>일일 브리핑 메일</strong>: 요약 결과를 지정 메일로 발송합니다.</li>
                <li><strong>VNC 접속</strong>: bid.tideflo.work 로그인이 필요할 때 VNC 버튼으로 브라우저에 접속합니다.</li>
                <li>우측 카탈로그에서 블록을 핀으로 고정해 자주 쓰는 워크플로를 저장할 수 있습니다.</li>
              </ul>
            </div>
          </section>

          {/* Agents */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Bot className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">에이전트 관리</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>각 에이전트의 역할·파일을 확인하고 편집합니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>파일 아이콘 클릭 → AGENTS.md, SOUL.md 등 설정 파일 편집.</li>
                <li>조직도 탭에서 에이전트 간 위임 관계를 시각적으로 확인합니다.</li>
              </ul>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[
                  ['AGENTS.md', '역할·업무 범위·행동 규칙 (핵심)'],
                  ['SOUL.md', '성격·말투·페르소나 (핵심)'],
                  ['TOOLS.md', '사용/금지 도구 정의'],
                  ['IDENTITY.md', '자기소개 내용'],
                  ['USER.md', '사용자 정보·선호사항'],
                  ['MEMORY.md', '기억 저장소 (자동 추가)'],
                  ['HEARTBEAT.md', '주기적 자동 실행 정의'],
                  ['BOOTSTRAP.md', '작업 환경 안내 (관리자 설정)'],
                ].map(([name, desc]) => (
                  <div key={name} className="p-2 bg-background rounded-lg">
                    <p className="font-medium text-text-primary text-xs">{name}</p>
                    <p className="text-xs text-text-secondary mt-0.5">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Cron */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">예약 작업 (Cron)</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>정해진 시간에 에이전트에게 자동으로 메시지를 보냅니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>프리셋 또는 직접 설정으로 시간·요일을 지정합니다.</li>
                <li>▶ 버튼으로 즉시 실행, ⏸ 버튼으로 일시 정지합니다.</li>
                <li>"실행 이력" 버튼으로 과거 실행 결과를 확인합니다.</li>
              </ul>
            </div>
          </section>

          {/* Channels */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Radio className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">채널 연동</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>Discord 등 외부 채널과 에이전트를 연결합니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>연결된 채널에서 메시지를 보내면 에이전트가 자동으로 응답합니다.</li>
              </ul>
            </div>
          </section>

          {/* Integrations */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Link className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">외부 연동</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>Gmail, Google Drive, Dooray 등 업무 도구와 연동합니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>연동 후 에이전트가 메일 조회·발송, 파일 검색 등을 수행할 수 있습니다.</li>
              </ul>
            </div>
          </section>

          {/* Tips */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Settings className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">기타 안내</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <ul className="list-disc pl-4 space-y-1">
                <li>우측 상단에서 서버 연결 상태를 확인할 수 있습니다.</li>
                <li>문제 발생 시 페이지 새로고침(F5)으로 대부분 해결됩니다.</li>
                <li>모델·권한 변경은 관리자에게 문의해주세요.</li>
              </ul>
            </div>
          </section>

        </div>

        <div className="p-4 border-t border-border-color text-center">
          <p className="text-xs text-text-secondary">TideClaw | 문의: 관리자에게 연락해주세요</p>
        </div>
      </div>
    </div>
  );
}
