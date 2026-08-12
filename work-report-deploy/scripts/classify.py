#!/usr/bin/env python3
"""사업 매핑 폴백 (B안).

1순위: 등록 식별자 — 마스터에 dooray_project_id·github_repos 가 있으면 확정
2순위: 컨테이너 이름 유사도 — 두레이 프로젝트명 ↔ 사업명/별칭
        (프로젝트명의 연도 접두어 "2026-" 는 벗기고 비교)
3순위: 별칭 키워드 — 제목/레포명에 별칭이 그대로 들어 있으면
그 외: biz_id=None (공통) — 틀리게 분류하느니 공통에 둔다. LLM 다듬기가 마지막 보정.
"""
import re

from dedupe import similarity

CONTAINER_SIM = 0.55


def _strip_year(name):
    return re.sub(r"^\s*20\d{2}\s*[-_.]?\s*", "", name or "").strip()


def business_for_container(container_name, businesses):
    """두레이 프로젝트명 같은 '그릇 이름'을 사업에 매칭."""
    if not container_name:
        return None
    cand = _strip_year(container_name)
    best, best_score = None, 0.0
    for b in businesses:
        keys = [b.get("name"), b.get("alias")] + list(b.get("aliases") or [])
        for key in keys:      # aliases = 옛 사업명 (예: 메타버스아카데미 → 가상융합)
            if not key:
                continue
            sc = similarity(cand, key)
            if sc > best_score:
                best, best_score = b, sc
    if best and best_score >= CONTAINER_SIM:
        return best["id"]
    return None


def business_for_text(text, businesses):
    """제목/레포명에 별칭이 통째로 들어 있으면 그 사업 (2자 이상 별칭만)."""
    if not text:
        return None
    for b in businesses:
        for alias in [b.get("alias")] + list(b.get("aliases") or []):
            alias = (alias or "").strip()
            if len(alias) >= 2 and alias in text:
                return b["id"]
    return None


def _registered(it, businesses):
    pid = it.get("project_id")
    repo = (it.get("repo") or "").lower()
    for b in businesses:
        if pid and pid == b.get("dooray_project_id"):
            return b["id"]
        if repo:
            for spec in b.get("github_repos") or []:
                if spec.lower().split("/")[-1] == repo.split("/")[-1]:
                    return b["id"]
    return None


def classify(items, businesses):
    """수집 항목에 biz_id 를 채운다 (이미 있으면 존중)."""
    for it in items:
        if it.get("biz_id"):
            continue
        it["biz_id"] = (
            _registered(it, businesses)
            or business_for_container(it.get("project"), businesses)
            or business_for_text(it.get("repo"), businesses)
            or business_for_text(it.get("text"), businesses)
        )
    return items
