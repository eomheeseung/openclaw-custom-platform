import sys
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from week_util import week_label, prev_week_label
from build_draft import split_common, group_by_business, find_unsourced, apply_carryover

def _it(text, biz_id, status="done", sources=None):
    return {"text": text, "biz_id": biz_id, "status": status,
            "sources": sources if sources is not None else [{"source": "dooray", "url": "u"}]}

def test_week_label_iso():
    assert week_label("2026-08-10") == "2026-W33"
    assert prev_week_label("2026-08-10") == "2026-W32"

def test_group_keeps_empty_businesses():
    """활동 없는 사업도 남긴다 — 빠뜨림/없음 구분"""
    bs = [{"id": "b1", "name": "사업1", "alias": "일"}, {"id": "b2", "name": "사업2", "alias": "이"}]
    out = group_by_business([_it("작업A", "b1")], bs)
    assert len(out) == 2 and out[1]["items"] == [] and out[0]["alias"] == "일"

def test_split_common():
    bs = [{"id": "b1", "name": "사업1"}]
    grouped, common = split_common([_it("작업A", "b1"), _it("전사 회의", None)], bs)
    assert [x["text"] for x in grouped] == ["작업A"]
    assert [x["text"] for x in common] == ["전사 회의"]

def test_find_unsourced():
    warns = find_unsourced([_it("정상", "b1"), _it("근거없음", "b1", sources=[])])
    assert [w["text"] for w in warns] == ["근거없음"]

def test_carryover_marks_continuing_item():
    prev_next = [{"text": "통계 화면 개선", "status": "next"}]
    out = apply_carryover([_it("통계 화면 개선", "b1", status="wip")], prev_next)
    assert out[0].get("carry") is True

def test_carryover_appends_untouched_item():
    prev_next = [{"text": "점검 일정 협의", "status": "next", "biz_id": "b1"}]
    out = apply_carryover([_it("다른 작업", "b1")], prev_next)
    carried = [x for x in out if x.get("carry")]
    assert len(carried) == 1 and carried[0]["text"] == "점검 일정 협의"
    assert carried[0]["status"] == "next" and carried[0]["sources"] == []

def test_carryover_done_absorbs():
    prev_next = [{"text": "로그인 오류 조치", "status": "next"}]
    out = apply_carryover([_it("로그인 오류 조치", "b1", status="done")], prev_next)
    assert len(out) == 1 and not out[0].get("carry")

def test_parse_repo_forms():
    from build_draft import parse_repo
    assert parse_repo("tideflo/e-jinro-web", None) == ("tideflo", "e-jinro-web")
    assert parse_repo("myrepo", "tideflo") == ("tideflo", "myrepo")
    assert parse_repo("", "tideflo") is None
    assert parse_repo("solo", None) is None   # owner 도 없으면 스킵

def test_gather_repos_business_and_personal():
    from build_draft import gather_github_repos
    bs = [{"id": "b1", "github_repos": ["tideflo/e-jinro-web", "e-jinro-admin"]}]
    gh = {"owner": "tideflo", "repo": "personal-a, other/perso-b"}
    out = gather_github_repos(bs, gh)
    assert ("tideflo", "e-jinro-web", "b1") in out
    assert ("tideflo", "e-jinro-admin", "b1") in out
    assert ("tideflo", "personal-a", None) in out
    assert ("other", "perso-b", None) in out
