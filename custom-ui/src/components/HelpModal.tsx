import { X, MessageSquare, Bot, Clock, Network, Settings, HelpCircle } from 'lucide-react';

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
          {/* Chat */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">채팅</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>AI 에이전트와 대화할 수 있는 메인 화면입니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>하단 입력창에 메시지를 입력하고 Enter 또는 전송 버튼을 눌러 보냅니다.</li>
                <li>Shift+Enter로 줄바꿈이 가능합니다.</li>
                <li>파일 첨부 버튼(클립 아이콘)으로 파일을 첨부할 수 있습니다.</li>
                <li>좌측 사이드바에서 에이전트를 선택하면 해당 에이전트와 새 대화가 시작됩니다.</li>
              </ul>
            </div>
          </section>

          {/* Sessions */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">세션 관리</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>대화는 "세션" 단위로 관리됩니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li><strong>새 세션</strong>: 좌측 사이드바 상단의 "새 세션" 버튼을 클릭합니다.</li>
                <li><strong>세션 전환</strong>: 좌측 사이드바의 세션 목록에서 다른 세션을 클릭하면 이전 대화 내역을 볼 수 있습니다.</li>
                <li>각 세션은 독립적인 대화 맥락을 유지합니다.</li>
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
              <p>에이전트는 특정 역할을 수행하는 AI 봇입니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li><strong>에이전트 추가</strong>: 상단 탭에서 "에이전트" 메뉴 선택 후 "새 에이전트" 버튼을 클릭합니다.</li>
                <li><strong>ID</strong>: 영문 소문자와 하이픈(-)만 사용 가능합니다. (예: my-bot)</li>
                <li><strong>이름</strong>: 화면에 표시되는 이름입니다. 한글 사용 가능합니다.</li>
                <li><strong>이모지</strong>: 에이전트를 구분하는 아이콘입니다.</li>
                <li><strong>시스템 프롬프트</strong>: 에이전트 카드의 파일 아이콘을 클릭하면 AGENTS.md 등의 파일을 편집할 수 있습니다. 여기에 에이전트의 역할과 행동 규칙을 작성합니다.</li>
              </ul>
              <div className="mt-3 p-3 bg-background rounded-lg">
                <p className="text-xs font-medium text-text-primary mb-1">시스템 프롬프트 예시 (AGENTS.md):</p>
                <pre className="text-xs text-text-secondary whitespace-pre-wrap">{`당신은 회사의 일정 관리 비서입니다.
- 회의 일정을 정리하고 알려줍니다
- 업무 요청을 분류하고 우선순위를 정합니다
- 항상 존댓말을 사용합니다`}</pre>
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
              <p>정해진 시간에 자동으로 봇에게 메시지를 보내는 기능입니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li><strong>생성</strong>: "새 예약 작업" 버튼을 클릭합니다.</li>
                <li><strong>스케줄</strong>: 빠른 선택 프리셋 또는 직접 설정으로 시간과 요일을 지정합니다.</li>
                <li><strong>수동 실행</strong>: 재생 버튼을 눌러 즉시 실행할 수 있습니다.</li>
                <li><strong>활성화/비활성화</strong>: 일시정지 버튼으로 작업을 켜고 끌 수 있습니다.</li>
                <li><strong>실행 이력</strong>: "실행 이력" 버튼으로 과거 실행 결과를 확인합니다.</li>
              </ul>
            </div>
          </section>

          {/* Org Chart */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Network className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">조직도</h3>
            </div>
            <div className="space-y-2 text-sm text-text-secondary pl-7">
              <p>등록된 에이전트들의 관계를 시각적으로 보여줍니다.</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>에이전트를 클릭하면 해당 에이전트와 새 대화를 시작합니다.</li>
                <li>서브에이전트 관계가 연결선으로 표시됩니다.</li>
              </ul>
            </div>
          </section>

          {/* Agent Files */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Bot className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-text-primary">에이전트 파일 종류</h3>
            </div>
            <div className="text-sm text-text-secondary pl-7">
              <p className="mb-3">각 에이전트는 아래 8개의 설정 파일을 가질 수 있습니다. 에이전트 관리 화면에서 파일 아이콘을 클릭하면 편집할 수 있습니다.</p>
              <div className="space-y-2">
                <div className="p-3 bg-background rounded-lg">
                  <p className="font-medium text-text-primary">AGENTS.md <span className="text-accent text-xs ml-1">핵심</span></p>
                  <p className="text-xs mt-1">에이전트의 역할, 업무 범위, 행동 규칙을 정의하는 시스템 프롬프트입니다.</p>
                </div>
                <div className="p-3 bg-background rounded-lg">
                  <p className="font-medium text-text-primary">SOUL.md <span className="text-accent text-xs ml-1">핵심</span></p>
                  <p className="text-xs mt-1">에이전트의 성격, 말투, 가치관 등 페르소나를 정의합니다.</p>
                </div>
                <div className="p-3 bg-background rounded-lg">
                  <p className="font-medium text-text-primary">TOOLS.md</p>
                  <p className="text-xs mt-1">사용 가능한 도구와 금지 도구, 사용 시 주의사항을 정의합니다.</p>
                </div>
                <div className="p-3 bg-background rounded-lg">
                  <p className="font-medium text-text-primary">IDENTITY.md</p>
                  <p className="text-xs mt-1">"너는 누구야?" 질문에 대한 자기소개 내용입니다.</p>
                </div>
                <div className="p-3 bg-background rounded-lg">
                  <p className="font-medium text-text-primary">USER.md</p>
                  <p className="text-xs mt-1">사용자의 직무, 선호사항 등을 알려줘서 맞춤형 답변을 받을 수 있습니다.</p>
                </div>
                <div className="p-3 bg-background rounded-lg">
                  <p className="font-medium text-text-primary">MEMORY.md</p>
                  <p className="text-xs mt-1">에이전트가 기억할 정보를 저장합니다. 대화 중에도 자동 추가됩니다.</p>
                </div>
                <div className="p-3 bg-background rounded-lg">
                  <p className="font-medium text-text-primary">HEARTBEAT.md</p>
                  <p className="text-xs mt-1">주기적 자동 실행 작업을 정의합니다. 보통 비워둡니다.</p>
                </div>
                <div className="p-3 bg-background rounded-lg">
                  <p className="font-medium text-text-primary">BOOTSTRAP.md <span className="text-yellow-400 text-xs ml-1">관리자 설정</span></p>
                  <p className="text-xs mt-1">작업 환경(폴더 구조, API 정보 등)을 안내합니다. 관리자가 공유 설정합니다.</p>
                </div>
              </div>
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
                <li><strong>연결 상태</strong>: 우측 상단에서 서버 연결 상태를 확인할 수 있습니다.</li>
                <li><strong>API 호출 수</strong>: 현재 세션에서의 API 호출 횟수가 표시됩니다.</li>
                <li><strong>모델 변경</strong>: AI 모델 설정은 관리자에게 문의해주세요.</li>
                <li><strong>문제 발생 시</strong>: 페이지를 새로고침(F5)하면 대부분 해결됩니다.</li>
              </ul>
            </div>
          </section>
        </div>

        <div className="p-4 border-t border-border-color text-center">
          <p className="text-xs text-text-secondary">TideClaw v1.0 | 문의: 관리자에게 연락해주세요</p>
        </div>
      </div>
    </div>
  );
}
