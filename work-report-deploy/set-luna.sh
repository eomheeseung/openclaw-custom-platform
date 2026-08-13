#!/usr/bin/env bash
# openai 프로바이더 등록 + 업무보고 에이전트 모델 지정.
# ⚠ 파일을 직접 고치지 않는다 — 실행 중 외부 수정은 게이트웨이가 되돌린다(.clobbered).
#   컨테이너 안의 `openclaw config set` 을 쓰면 검증·백업까지 게이트웨이가 한다.
set -u
NN="$1"; C="openclaw-user${NN}"
docker ps --format '{{.Names}}' | grep -qx "$C" || { echo "user${NN}: 컨테이너 없음"; exit 0; }

PROV='{"baseUrl":"https://api.openai.com/v1","api":"openai-completions","models":[{"id":"gpt-5.6-luna","name":"GPT-5.6 Luna","reasoning":true,"input":["text","image"],"contextWindow":400000,"maxTokens":128000}]}'
docker exec -u node "$C" openclaw config set models.providers.openai "$PROV" --strict-json >/dev/null 2>&1 \
  && echo "  프로바이더 등록" || { echo "  ⚠ 프로바이더 등록 실패"; exit 1; }

IDX=$(docker exec -u node "$C" openclaw config get agents.list 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(-1); raise SystemExit
print(next((i for i,a in enumerate(d) if a.get('id')=='work-report'), -1))")
if [ "$IDX" -ge 0 ] 2>/dev/null; then
  docker exec -u node "$C" openclaw config set "agents.list[${IDX}].model" \
    '{"primary":"openai/gpt-5.6-luna","fallbacks":["moonshot/kimi-k3"]}' --strict-json >/dev/null 2>&1 \
    && echo "  업무보고 모델 지정 (index ${IDX})" || echo "  ⚠ 모델 지정 실패"
else
  echo "  업무보고 미배포 — 프로바이더만 (배포 시 자동 적용)"
fi
