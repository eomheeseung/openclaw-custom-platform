import sys
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from collect import normalize_item, tool_enabled

def test_normalize_item_keeps_required_keys():
    raw = {"subject": "확인서 오류 수정", "updatedAt": "2026-08-05T10:00:00+09:00"}
    it = normalize_item(raw, source="dooray", biz_id="biz-sports",
                        url="https://x/142", status="done")
    assert (it["text"], it["source"], it["biz_id"], it["status"]) == \
           ("확인서 오류 수정", "dooray", "biz-sports", "done")
    assert it["url"] == "https://x/142" and it["at"].startswith("2026-08-05")

def test_tool_enabled_respects_config():
    assert tool_enabled(["dooray", "gmail"], "dooray") is True
    assert tool_enabled(["dooray", "gmail"], "figma") is False

def test_sr_is_never_enabled():
    """SR 은 설정에 있어도 무시 — 처리 담당자 구분 불가로 영구 제외"""
    assert tool_enabled(["dooray", "sr"], "sr") is False

def test_github_requires_author_on_shared_repo():
    """공용 저장소 — username 없으면 수집하지 않고 실패로 드러낸다 (타인 커밋 오염 방지)"""
    from collect import collect_github
    items, ok = collect_github("tideflo", "2026-08-10", "2026-08-14", token="t", author=None)
    assert items == [] and ok is False

def test_github_unconfigured_is_not_failure():
    from collect import collect_github
    items, ok = collect_github(None, "2026-08-10", "2026-08-14")
    assert items == [] and ok is True

def test_normalize_item_carries_mapping_fields():
    """project/repo 는 classify 가 사업 매핑에 쓰는 필드 — 유실되면 안 됨"""
    it = normalize_item({"subject": "작업"}, "dooray", project="2026-금연서비스", project_id="123")
    assert it["project"] == "2026-금연서비스" and it["project_id"] == "123"

def test_in_period_filters_past_items():
    """실측 버그: 두레이 CLI 에 기간 파라미터가 없어 1년치 과거 task 가 딸려 왔다"""
    from collect import in_period
    assert in_period("2026-08-12T10:00:00+09:00", "2026-08-10", "2026-08-14") is True
    assert in_period("2025-08-22T10:00:00+09:00", "2026-08-10", "2026-08-14") is False
    assert in_period("", "2026-08-10", "2026-08-14") is False


def test_stale_wip_window():
    """실측: 1년 넘게 열려만 있는 진행중 task 가 주간보고에 딸려 왔다"""
    from collect import _days_before, WIP_STALE_DAYS, in_period
    lo = _days_before("2026-08-10", WIP_STALE_DAYS)
    assert in_period("2026-08-01T00:00:00", lo, "2026-08-14") is True   # 최근 진행중 → 유지
    assert in_period("2025-09-05T00:00:00", lo, "2026-08-14") is False  # 방치 → 제외


def test_iso_normalizes_rfc2822_date():
    """gmail date 가 'Wed, 12 Aug 2026 …' 라 기간비교·표시가 깨졌다"""
    from collect import _iso
    assert _iso("Wed, 12 Aug 2026 03:02:26 +0000").startswith("2026-08-12")
    assert _iso("2026-08-12T09:00:00+09:00").startswith("2026-08-12")
    assert _iso("") == ""


def test_clean_title_strips_prefixes_mechanically():
    """LLM 에 맡기면 한글을 새로 생성해 글자가 깨진다(실측: 업무→업묵/업뭏) — 규칙으로 지운다"""
    from collect import clean_title
    assert clean_title("Re: 회의 일정") == "회의 일정"
    assert clean_title("Re: RE: 회의") == "회의"
    assert clean_title("[공지] Fwd: 배포 안내") == "배포 안내"
    assert clean_title("[Docswave] [회람 문서] [결재] 연차신청서") == "연차신청서"
    assert clean_title("정상 제목") == "정상 제목"
    assert clean_title("") == ""


def test_clean_title_uses_tag_when_title_is_all_tags():
    """제목이 대괄호뿐이면 전부 지워져 빈 문자열이 된다 — 첫 태그 안을 제목으로"""
    from collect import clean_title
    assert clean_title("Fwd: [주간업무보고 회의록][2026-08-10]") == "주간업무보고 회의록"
    assert clean_title("[주간보고][2026-08-10~2026-08-14]") == "주간보고"


def test_filters_ad_and_others_approval():
    """다듬기(LLM)를 건너뛰는 회차가 있어 명백한 노이즈는 수집에서 거른다"""
    from collect import is_ad_mail, is_others_approval
    assert is_ad_mail("(광고) 기업AX 사례", "edu@ablearn.kr") is True
    assert is_ad_mail("2026 혁신의숲 어워드 후보 공개", "support@innoforest.co.kr") is True
    assert is_ad_mail("주간업무보고 회의록", "da0ab@tideflo.com") is False
    assert is_others_approval("[Docswave] [결재] 연차신청서-서완덕", "손재민") is True
    assert is_others_approval("[Docswave] [결재] 연차신청서-손재민", "손재민") is False
    assert is_others_approval("주간업무보고 회의록", "손재민") is False


def test_filters_place_only_calendar():
    from collect import RE_CAL_NOISE
    assert RE_CAL_NOISE.match("사무실")
    assert RE_CAL_NOISE.match("재택")
    assert not RE_CAL_NOISE.match("주간업무보고 회의")
