#!/usr/bin/env python3
"""다듬기 결과를 번호로만 받아 초안에 반영한다.

왜 파일을 통째로 다시 쓰게 하지 않는가:
  9KB JSON 을 모델이 재작성하게 했더니 한 회차가 4분 넘게 걸렸다(실측 247초 관측).
  게다가 그 과정에서 한글이 깨지고(업무→업묵) sources 가 사라졌다.
  바꿀 항목만 번호로 받으면 출력이 몇백 바이트로 줄고, 손대지 않은 항목은 원본 그대로 남는다.

사용법:
  python3 polish.py '{"3":{"text":"밀도 메타광고 리포트 작성"},"7":{"status":"next"},"12":{"drop":true}}'
  python3 polish.py --add '진행' 'AI로 주간보고 자동화'      # 새 항목(직접 입력)

키는 항목 번호(build_draft.py 출력의 items[].n). 값은 셋 중 아무거나:
  text   바꿀 문장          status  done|wip|next        drop  true 면 제외
"""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
import verify_draft
import week_util

STATUS = {"done", "wip", "next"}


def _lists(draft):
    yield from ((g["items"], g) for g in draft.get("businesses") or [])
    yield (draft.setdefault("common", []), None)


def _fix_replacement(new, origin):
    """깨진 문자(U+FFFD)를 원문 글자로 되돌린다.

    모델이 명령 인자로 한글을 넘기는 과정에서 글자가 통째로 깨져 들어온다
    (실측: 검색시스템 → 검색시스\ufffd\ufffd). 초성 비교로는 못 잡는다 —
    깨진 문자에는 초성이 없고 글자 수도 달라진다. 원문과 맞춰 그 자리만 되돌린다."""
    if "\ufffd" not in (new or "") or not origin:
        return new
    import difflib
    out, sm = [], difflib.SequenceMatcher(None, new, origin, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        seg = new[i1:i2]
        out.append(origin[j1:j2] if tag in ("replace", "delete") and "\ufffd" in seg else seg)
    fixed = "".join(out)
    return fixed if "\ufffd" not in fixed else new


def _restore_from(new, origin):
    """원문에 있던 단어가 초성만 같고 글자가 다르게 바뀌었으면 원문 글자로 되돌린다.
    사전(TERMS)에 없는 고유명사·사업명이 깨지는 경우를 잡는다."""
    if not new or not origin:
        return new
    import re as _re
    words = [w for w in _re.split(r"[^0-9A-Za-z가-힣]+", origin) if len(w) >= 2]
    return verify_draft.fix_typos(new, terms=words) if words else new


def apply(draft, edits):
    """되돌려주는 값에 **최종 문장**을 함께 담는다.

    자동 교정 때문에 모델이 보낸 문장과 저장된 문장이 달라진다. 그러면 모델이
    "안 반영됐다" 고 보고 같은 요청을 다섯 번씩 다시 보낸다(실측: 450초 낭비).
    최종 문장을 알려주면 다시 보낼 이유가 없어진다."""
    changed, dropped, unknown = 0, 0, []
    applied, corrected = {}, []
    for key, val in (edits or {}).items():
        try:
            n = int(key)
        except (TypeError, ValueError):
            unknown.append(key)
            continue
        hit = None
        for items, _ in _lists(draft):
            for it in items:
                if it.get("n") == n:
                    hit = (items, it)
                    break
            if hit:
                break
        if not hit:
            unknown.append(key)
            continue
        items, it = hit
        if isinstance(val, str):
            val = {"text": val}
        if val.get("drop"):
            items.remove(it)
            dropped += 1
            continue
        if val.get("text"):
            # 모델이 한글을 다시 타이핑하면서 글자를 깨뜨린다(업무→업묵). 저장 직전에 되돌린다.
            # 여기서 안 잡으면 모델이 파일을 다시 읽고 스스로 고치려 들면서 같은 요청이
            # 대여섯 번 반복된다(실측: 한 회차 170초).
            new = str(val["text"]).strip()[:300]
            origin = it.get("raw_text") or it.get("text") or ""
            # 사전 기반 교정은 쓰지 않는다 — 멀쩡한 단어를 망가뜨렸다(보건소→보고소)
            fixed = _fix_replacement(new, origin)
            fixed = _restore_from(fixed, origin)
            it["text"] = fixed
            if fixed != new:
                corrected.append({"n": n, "보낸값": new, "저장값": fixed})
        if val.get("status") in STATUS:
            it["status"] = val["status"]
        applied[str(n)] = it["text"]
        changed += 1
    return changed, dropped, unknown, applied, corrected


def add(draft, section, text):
    """수집에 안 잡힌 일을 직접 넣는다. 출처가 없는 게 정상이므로 carry 로 표시해
    ⚠ 경고를 띄우지 않는다."""
    status = "next" if section.startswith(("진행", "차주", "next")) else "done"
    bucket = draft.setdefault("ai", []) if section.upper() == "AI" else draft.setdefault("common", [])
    bucket.append({"text": text.strip()[:300], "status": status, "sources": [], "carry": True})


def save(nn, week, draft):
    path = f"{paths.data_dir(nn)}/work-report/drafts/draft-{week}.json"
    draft["edited_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    tmp = f"{path}.tmp"
    json.dump(draft, open(tmp, "w"), ensure_ascii=False, indent=2)
    os.replace(tmp, path)     # 원자적 교체 — 발송이 반쯤 쓰인 파일을 읽지 않게


if __name__ == "__main__":
    nn = paths.self_nn()
    if not nn:
        print(json.dumps({"ok": False, "error": "사용자 번호를 알 수 없습니다"}, ensure_ascii=False))
        sys.exit(2)
    week = week_util.week_label(datetime.now().strftime("%Y-%m-%d"))
    path = f"{paths.data_dir(nn)}/work-report/drafts/draft-{week}.json"
    try:
        draft = json.load(open(path))
    except FileNotFoundError:
        print(json.dumps({"ok": False, "error": "초안 파일이 없습니다"}, ensure_ascii=False))
        sys.exit(1)

    argv = sys.argv[1:]
    if argv and argv[0] == "--add":
        if len(argv) < 3:
            print(json.dumps({"ok": False, "error": "--add <완료|진행|AI> <문장>"}, ensure_ascii=False))
            sys.exit(2)
        add(draft, argv[1], " ".join(argv[2:]))
        save(nn, week, draft)
        print(json.dumps({"ok": True, "added": 1}, ensure_ascii=False))
        sys.exit(0)

    raw = " ".join(argv) if argv else sys.stdin.read()
    try:
        edits = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"JSON 이 아닙니다: {e}"}, ensure_ascii=False))
        sys.exit(2)
    changed, dropped, unknown, applied, corrected = apply(draft, edits)
    save(nn, week, draft)
    out = {"ok": True, "changed": changed, "dropped": dropped, "unknown": unknown,
           "저장된_문장": applied}
    if corrected:
        # 깨진 글자를 되돌린 건 정상 동작이다 — 다시 보내지 말라고 명시한다
        out["자동교정"] = corrected
        out["안내"] = "깨진 글자를 원문으로 되돌렸습니다. 정상이니 다시 보내지 마세요."
    print(json.dumps(out, ensure_ascii=False))
