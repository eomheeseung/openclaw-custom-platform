# 업무보고 에이전트 — 진행 원장

플랜: docs/plans/2026-08-10-work-report-agent.md
대상: user02(손재민) 컨테이너만 · 라이브 운영 서버
시작: 2026-08-10

## 사전 결정
- 라이브(/opt/openclaw)에서 작업 → 저장소로 복사해 커밋 (①-A)
- 기존 미커밋 변경 5건 선커밋 완료 (282a9cb..5a8cfa2) (②-A)
- master 브랜치 직접 사용 (이 저장소 관행)

## 완료
- Task 1: complete (commits c63f384..10b353e, review clean)
  - 배포 스캐폴딩 4파일 + user02 에이전트 등록
  - 리뷰 Important #1(원자적 쓰기) 수정 완료 · #2(AGENTS.md 자동갱신)는 watch-agents.sh 정상동작으로 확인, 수정 불필요
  - Minor 기록(최종 리뷰에서 판단): chmod 777/666 관행 · NN 형식검증 부재 · unenroll 데이터보존 문서화 부족

## 결정 대기 (사용자 판단 필요)
- [ ] **A. 차주 예정 이월 대조** — 직전 draft.json 의 「차주」 항목을 이번 회차와 대조.
      했으면 완료로 이어붙이고, 안 했으면 그대로 남김. Task 5 에 추가 · 반나절 규모.
      → 이게 있어야 "주간 스냅샷"이 아니라 "관리 루프"가 됨.
- [ ] **B. keyword_map 확장 범위** — 현재 계획은 work-report·business-report 두 줄만 추가.
      기존 커스텀 에이전트(docwriter·bid-reviewer·planmanager 등)도 함께 등록하면
      위임 0건인 7명(user01·04·09·10·11·14·16)에게 즉시 효과.

## 두레이 연동 방향 (2026-08-12 결정)
- **채택**: 두레이 메신저 활용 — B안(지시 받기 + 알림 회신)
  - 기술 확인 완료: OpenClaw `webhooks` 확장에 `path`/`sessionKey`/`secret`/`controllerId` 필드 존재
  - 두레이 Outgoing → webhooks(sessionKey로 세션 투입) → 처리 → Incoming으로 회신
  - A(알림)는 B에 포함됨 — B의 마지막 단계가 알림이라 따로 만들 필요 없음
  - 현재 상태: webhooks 설정 **전무**, 두레이 incoming URL **없음** → 신규 개발
- **보류**: C안(두레이 task 이벤트 트리거) — 나중에 고려
  - 무엇에 반응할지 규칙이 먼저 정해져야 하고, 출력 통로(A)가 선행되어야 함
- 지금 진행 중인 플랜(Task 2~11)과 **독립 과제**. 현 작업 완료 후 착수.

## ⏸ 구현 일시 중지 (2026-08-12)
- 사용자 지시: 설계 재점검 — **사용자 시나리오 목업**으로 흐름을 먼저 확인
- 두레이 활용(B안)을 시나리오에 포함할 것
- Task 2 이후 보류. Task 1 산출물(user02 등록)은 유지 — 시나리오 확정 후 재개

## ✅ 결정 확정 (2026-08-12)
- A. 차주 예정 이월 대조 — **채택** (직전 draft 대조, 「지난주 예정 → 계속」)
- B. keyword_map 확장 — **채택** (work-report·business-report + 기존 커스텀 에이전트)
- 공휴일·연차 분기 — 채택 / 수집 부분 실패 배지 — 채택
- 진행 방식: 스펙 통합(스킬 없이) → writing-plans 로 플랜 재작성 → 인라인 실행 + 위험 태스크만 서브에이전트 리뷰
- 두레이 B안은 별도 페이즈(코어 완료 후) 유지

## 플랜 v2 (2026-08-12)
- 스펙: docs/specs/2026-08-12-work-report-design.md (통합 확정본)
- 플랜: docs/plans/2026-08-12-work-report-plan.md — Phase 1 (Task 2~11, user02) + Phase 2 (Task 12~15, 두레이 B안)
- 구 플랜(2026-08-10)은 Task 1 완료분만 유효, 이후 태스크는 v2 로 대체
- 실행: 인라인(executing-plans) + 위험 태스크(7·10·11)만 서브에이전트 리뷰
