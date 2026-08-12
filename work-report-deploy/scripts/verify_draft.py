#!/usr/bin/env python3
"""다듬기 결과 검증 — 모델이 한글을 재생성하며 깨뜨린 글자를 되돌린다.

실측: "주간업무보고" 가 매번 다른 글자로 깨졌다 (업묵 / 업뫃 / 업뭏).
자모로 보면 규칙이 있다 — **초성은 맞고 중성·종성만 흔들린다.**
    무 = ㅁ+ㅜ      묵 = ㅁ+ㅜ+ㄱ      뫃 = ㅁ+ㅗ+ㅎ
그래서 "초성이 전부 일치하는데 글자 하나만 다르면" 깨진 것으로 보고 되돌린다.
"업체보고"처럼 **뜻이 다른 단어는 초성이 달라** 건드리지 않는다.

문구 재작성 자체는 막지 않는다 — 막아봤더니 광고·타인 결재가 안 걸러졌다(실측).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths

HANGUL_BASE = 0xAC00
HANGUL_END = 0xD7A3

# 업무 문서에 반복해서 나오는 말들. 여기 없는 단어는 검사하지 않는다(오탐 방지).
TERMS = [
    "업무보고", "주간보고", "업무", "보고", "회의", "참석", "제안서", "산출물",
    "유지관리", "유지보수", "운영", "구축", "개발", "검토", "작성", "수정",
    "대응", "점검", "배포", "테스트", "기획", "설계", "분석", "협의", "공유",
    "일정", "요청", "확인", "정리", "회의록", "납품", "계약", "정산", "교육",
]


def _cho(ch):
    """초성 인덱스. 한글이 아니면 문자 자체를 돌려 비교에 쓴다."""
    c = ord(ch)
    if HANGUL_BASE <= c <= HANGUL_END:
        return (c - HANGUL_BASE) // 588
    return ch


def _cho_seq(s):
    return tuple(_cho(c) for c in s)


def fix_typos(text, terms=TERMS):
    """초성이 전부 같은데 한 글자만 다른 구간을 사전 단어로 되돌린다.

    ⚠ 그 구간 자체가 이미 올바른 단어면 건드리지 않는다.
    "회의"↔"협의" 는 초성이 (ㅎ,ㅇ) 로 같아 규칙만으로는 구분되지 않는다(실측 오탐)."""
    if not text:
        return text
    known = set(terms)
    for term in terms:
        n = len(term)
        i = 0
        while i + n <= len(text):
            seg = text[i:i + n]
            if (seg != term and seg not in known
                    and _cho_seq(seg) == _cho_seq(term)
                    and sum(1 for a, b in zip(seg, term) if a != b) == 1):
                text = text[:i] + term + text[i + n:]
            i += 1
    return text


def business_terms(businesses):
    """사업명·별칭도 사전에 넣는다 — 기관 제출 문서에서 가장 틀리면 안 되는 말이다."""
    out = []
    for b in businesses or []:
        for key in [b.get("name"), b.get("alias")] + list(b.get("aliases") or []):
            key = (key or "").strip()
            if len(key) >= 2 and any(HANGUL_BASE <= ord(c) <= HANGUL_END for c in key):
                out.append(key)
    return out


def verify(nn, week):
    path = f"{paths.data_dir(nn)}/work-report/drafts/draft-{week}.json"
    d = json.load(open(path))
    terms = TERMS + business_terms(paths.load_master().get("businesses", []))
    fixed = []
    for grp in list(d.get("businesses") or []) + [{"items": d.get("common") or []}]:
        for it in grp.get("items") or []:
            before = it.get("text", "")
            after = fix_typos(before, terms)
            if after != before:
                it["text"] = after
                fixed.append({"before": before, "after": after})
    for it in d.get("ai") or []:
        before = it.get("text", "")
        after = fix_typos(before, terms)
        if after != before:
            it["text"] = after
            fixed.append({"before": before, "after": after})
    if fixed:
        tmp = f"{path}.tmp"
        json.dump(d, open(tmp, "w"), ensure_ascii=False, indent=2)
        os.replace(tmp, path)      # 원자적 — 다듬기와 겹쳐도 반쯤 쓰인 파일이 남지 않는다
    return fixed


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("사용법: verify_draft.py <userNN> <주차: 2026-W33>")
        sys.exit(2)
    try:
        fixed = verify(sys.argv[1], sys.argv[2])
        print(json.dumps({"ok": True, "fixed": len(fixed), "items": fixed}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
