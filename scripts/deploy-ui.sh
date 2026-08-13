#!/usr/bin/env bash
# 커스텀 UI 빌드 → 배포 → 실제 서빙되는 해시까지 확인.
# ⚠ 배포 경로는 /opt/openclaw/custom-ui **바로 아래** 다 (index.html + assets/).
#   dist/ 하위에 넣으면 nginx 가 못 읽는데 rsync 는 성공해서 배포된 줄 알게 된다(실측 3회).
set -euo pipefail
cd "$(dirname "$0")/../custom-ui"
npm run build
rsync -a dist/ /opt/openclaw/custom-ui/
chown -R tideclaw:tideclaw /opt/openclaw/custom-ui/index.html /opt/openclaw/custom-ui/assets

want=$(grep -o 'index-[A-Za-z0-9_-]*\.js' dist/index.html | head -1)
live=$(curl -s http://localhost:3000/ | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1)
[ "$want" = "$live" ] || { echo "배포 실패: 빌드=$want 서빙=$live"; exit 1; }
echo "배포 완료: $live"
