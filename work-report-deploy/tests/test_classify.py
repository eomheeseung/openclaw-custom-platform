import sys
sys.path.insert(0, '/opt/openclaw/work-report-deploy/scripts')
from classify import classify, business_for_container, business_for_text

BS = [
    {"id": "biz-sports", "name": "대한체육회 e진로지원센터", "alias": "e진로",
     "dooray_project_id": "4332881555667186223", "github_repos": ["tideflo/e-jinro-web"]},
    {"id": "biz-smoking", "name": "금연서비스 통합정보시스템", "alias": "금연서비스",
     "dooray_project_id": "", "github_repos": []},
]

def _it(**kw):
    base = {"text": "", "biz_id": None, "source": "x", "url": None, "at": "", "status": "done"}
    base.update(kw)
    return base

def test_container_matches_year_prefixed_project():
    """실측: 두레이 프로젝트명은 '2026-금연서비스통합정보시스템' 형태 (연도 접두어)"""
    assert business_for_container("2026-금연서비스통합정보시스템", BS) == "biz-smoking"
    assert business_for_container("2024-금연서비스통합정보시스템", BS) == "biz-smoking"

def test_container_unrelated_project_stays_none():
    assert business_for_container("2025-경기연구원(경기도균형발전지원센터)", BS) is None

def test_registered_dooray_id_wins():
    it = _it(project="이상한이름", project_id="4332881555667186223")
    assert classify([it], BS)[0]["biz_id"] == "biz-sports"

def test_registered_repo_maps():
    it = _it(repo="e-jinro-web", text="fix: 로그인")
    assert classify([it], BS)[0]["biz_id"] == "biz-sports"

def test_alias_keyword_in_mail_subject():
    it = _it(text="[금연서비스] 검수 일정 회신", source="gmail")
    assert classify([it], BS)[0]["biz_id"] == "biz-smoking"

def test_plain_mail_stays_common():
    it = _it(text="확인서 오류 관련 회신", source="gmail")
    assert classify([it], BS)[0]["biz_id"] is None

def test_existing_biz_id_respected():
    it = _it(text="금연서비스 언급되지만", biz_id="biz-sports")
    assert classify([it], BS)[0]["biz_id"] == "biz-sports"

SVC = [
    {"id": "svc-01", "name": "묘한사주", "alias": "묘한사주", "aliases": ["ToonFortune"]},
    {"id": "svc-02", "name": "데일리뉴스나우", "alias": "데일리뉴스나우", "aliases": ["newsnow"]},
    {"id": "svc-03", "name": "밀도", "alias": "밀도", "aliases": ["persona_match", "mildo"]},
]

def test_repo_name_matches_english_alias():
    """레포 등록 없이 별칭만으로 매핑 — 레포가 늘어도 등록 불필요"""
    assert classify([_it(repo="infconn/ToonFortune")], SVC)[0]["biz_id"] == "svc-01"
    assert classify([_it(repo="infconn/ToonFortune-api")], SVC)[0]["biz_id"] == "svc-01"
    assert classify([_it(repo="infconn/newsnow")], SVC)[0]["biz_id"] == "svc-02"
    assert classify([_it(repo="eomheeseung/persona_match_front")], SVC)[0]["biz_id"] == "svc-03"

def test_unrelated_repo_stays_common():
    assert classify([_it(repo="tideflo/internal-tools")], SVC)[0]["biz_id"] is None
