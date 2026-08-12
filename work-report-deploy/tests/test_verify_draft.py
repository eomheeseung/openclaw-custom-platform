import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

from verify_draft import fix_typos


def test_restores_broken_syllable():
    """실측 사고: 모델이 '주간업무보고' 를 매번 다른 글자로 깨뜨렸다"""
    assert fix_typos("주간업묵보고 회의 참석") == "주간업무보고 회의 참석"
    assert fix_typos("주간업뫃보고 회의 참석") == "주간업무보고 회의 참석"


def test_leaves_different_words_alone():
    """초성이 다르면 뜻이 다른 단어다 — 건드리면 안 된다"""
    assert fix_typos("업체보고 정리") == "업체보고 정리"
    assert fix_typos("월간보고 작성") == "월간보고 작성"


def test_leaves_correct_text_untouched():
    assert fix_typos("주간업무보고 회의 참석") == "주간업무보고 회의 참석"
    assert fix_typos("mildo(밀도) 로그인 이슈 대응") == "mildo(밀도) 로그인 이슈 대응"
    assert fix_typos("") == ""


def test_only_one_broken_char_is_fixed():
    """두 글자 이상 다르면 오타가 아니라 다른 말이다 — 손대지 않는다"""
    assert fix_typos("주간읍묵보고") == "주간읍묵보고"


def test_custom_terms_cover_business_names():
    """사업명은 기관 제출 문서에서 가장 틀리면 안 되는 말이다"""
    assert fix_typos("가상융합기술 아카데미", ["가상융합기술"]) == "가상융합기술 아카데미"
    assert fix_typos("가상융합깁술 점검", ["가상융합기술"]) == "가상융합기술 점검"


def test_does_not_confuse_similar_valid_words():
    """실측 오탐: '회의'↔'협의' 는 초성이 (ㅎ,ㅇ) 로 같다. 둘 다 올바른 말이다"""
    assert fix_typos("주간업무보고 회의 참석") == "주간업무보고 회의 참석"
    assert fix_typos("일정 협의 진행", ["회의", "협의", "일정"]) == "일정 협의 진행"
