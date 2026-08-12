import sys
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from dedupe import merge_duplicates, compress_minor, similarity

def _it(text, source, url=None, at="2026-08-05T10:00:00+09:00", status="done"):
    return {"text": text, "source": source, "url": url, "biz_id": "b1",
            "at": at, "status": status}

def test_similar_titles_merge_into_one():
    out = merge_duplicates([
        _it("교육훈련비 확인서 오류 수정", "dooray", "u1"),
        _it("교육훈련비 확인서 오류 관련 회신", "gmail", "u2"),
    ])
    assert len(out) == 1
    assert {s["source"] for s in out[0]["sources"]} == {"dooray", "gmail"}

def test_unrelated_items_stay_separate():
    assert len(merge_duplicates([_it("확인서 오류 수정", "dooray"),
                                 _it("서버 이전 작업", "dooray")])) == 2

def test_far_apart_in_time_not_merged():
    out = merge_duplicates([
        _it("확인서 오류 수정", "dooray", at="2026-08-01T10:00:00+09:00"),
        _it("확인서 오류 수정", "gmail",  at="2026-08-07T10:00:00+09:00"),
    ])
    assert len(out) == 2

def test_wip_wins_over_done_on_merge():
    out = merge_duplicates([
        _it("통계 화면 개선", "dooray", status="wip"),
        _it("통계 화면 개선 회신", "gmail", status="done"),
    ])
    assert out[0]["status"] == "wip"

def test_minor_items_compressed():
    items = [_it(f"문구 수정 {i}", "dooray") for i in range(4)] + [_it("서버 이전", "dooray")]
    out = compress_minor(items, threshold=3)
    merged = [x for x in out if x.get("merged_count")]
    assert len(merged) == 1 and merged[0]["merged_count"] == 4 and "4건" in merged[0]["text"]

def test_minor_below_threshold_kept():
    out = compress_minor([_it("문구 수정 1", "dooray"), _it("문구 수정 2", "dooray")], threshold=3)
    assert all(not x.get("merged_count") for x in out)

def test_similarity_bounds():
    assert similarity("확인서 오류 수정", "확인서 오류 수정") == 1.0
    assert similarity("확인서 오류 수정", "완전히 다른 내용") < 0.5
