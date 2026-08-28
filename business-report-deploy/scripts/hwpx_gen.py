#!/usr/bin/env python3
"""
hwpx 템플릿의 표 셀 값을 교체해서 새 hwpx 파일을 생성한다.

사용:
  python3 hwpx_gen.py <template.hwpx> <output.hwpx> <data.json>

data.json 예시:
{
  "period": "2026. 07. 13 ~ 2026. 07. 17",
  "progress": [
    "홈페이지 수정사항 반영",
    "SSL 인증서 갱신 자동배포"
  ],
  "planned": [
    "SSL 자동배포 완료"
  ],
  "work_items": [
    {"no": "1", "title": "홈페이지 수정사항 반영", "details": ["A", "B"], "status": "작업완료", "memo": ""},
    {"no": "2", "title": "SSL 인증서 갱신", "details": [], "status": "진행중", "memo": "주말 무중단"}
  ]
}

주의:
- 템플릿의 표 1은 "9행 × 2열 사업정보 표"라고 가정 (기간=[3,1], 진행사항=[5,1], 예정사항=[6,1])
- 표 2는 "3행 × 4열, 첫 행 헤더" 라고 가정. 데이터 행은 하나만 있는 상태여야 함 (그것을 template로 복제)
"""
import sys
import json
import os
import shutil
import zipfile
import copy
import tempfile
import xml.etree.ElementTree as ET

NS_S = 'http://www.hancom.co.kr/hwpml/2011/section'
ET.register_namespace('', NS_S)


def local(el):
    return el.tag.split('}')[-1]


def find_children(el, name):
    return [c for c in el if local(c) == name]


def get_cell(tbl, ri, ci):
    trs = find_children(tbl, 'tr')
    tcs = find_children(trs[ri], 'tc')
    return tcs[ci]


def set_cell_lines(cell, lines, fallback_template=None):
    """셀 내부의 모든 <p> 문단을 지우고, 라인 개수만큼 새 문단 추가 (기존 스타일 유지).
    셀이 원래 비어있어서 <t> template 을 못 찾으면 fallback_template 사용 가능."""
    subList = find_children(cell, 'subList')[0]
    old_paras = find_children(subList, 'p')

    # 스타일이 살아있는 template 문단 찾기 (<t> 요소가 있는 것)
    template = None
    for p in old_paras:
        ts = [t for t in p.iter() if local(t) == 't']
        if ts:
            template = p
            break
    # <t> 없으면 fallback_template 사용 (다른 셀의 문단)
    if template is None and fallback_template is not None:
        template = fallback_template
    if template is None and old_paras:
        template = old_paras[-1]
    if template is None:
        return  # 정말 아무것도 없으면 포기

    for p in old_paras:
        subList.remove(p)

    if not lines:
        lines = ['']

    for line in lines:
        new_p = copy.deepcopy(template)
        ts = [t for t in new_p.iter() if local(t) == 't']
        if ts:
            # 첫 <t>에 새 텍스트만 남기기: 자식 요소(<lineBreak/> 등)와 tail 모두 제거
            ts[0].text = line
            for child in list(ts[0]):
                ts[0].remove(child)
            # 나머지 <t>도 텍스트·자식·tail 다 비우기
            for t in ts[1:]:
                t.text = ''
                for child in list(t):
                    t.remove(child)
        # 미리 계산된 줄바꿈 위치(<linesegarray>) 제거 → Hancom이 열 때 재계산
        for lsa in [el for el in list(new_p) if local(el) == 'linesegarray']:
            new_p.remove(lsa)
        subList.append(new_p)


def rebuild_work_items(tbl, items):
    """표2: 헤더 유지, 데이터 행 재구성."""
    trs = find_children(tbl, 'tr')
    if len(trs) < 2:
        raise RuntimeError('표2에 헤더+최소 1개 데이터 행이 필요')
    row_template = trs[1]

    # 기존 데이터 행 다 제거 (헤더만 남김)
    for tr in trs[1:]:
        tbl.remove(tr)

    for ri, item in enumerate(items, start=1):
        new_row = copy.deepcopy(row_template)
        cells = find_children(new_row, 'tc')
        # 4개 컬럼: NO / 기능개선 내용 / 작업현황 / 비고
        vals = [
            [item.get('no', str(ri))],
            _build_content_lines(item),
            [item.get('status', '')],
            [item.get('memo', '')],
        ]
        for ci, lines in enumerate(vals):
            set_cell_lines(cells[ci], lines)
            for c in cells[ci]:
                if local(c) == 'cellAddr':
                    c.set('rowAddr', str(ri))
        tbl.append(new_row)

    tbl.set('rowCnt', str(1 + len(items)))


def _build_content_lines(item):
    """작업항목 셀 내용: title + 하위 details 대시로 나열"""
    lines = [item.get('title', '')]
    for d in item.get('details', []):
        if d:
            lines.append(f'- {d}')
    return lines


def apply(section_path, data):
    tree = ET.parse(section_path)
    root = tree.getroot()
    tbls = [el for el in root.iter() if local(el) == 'tbl']
    if len(tbls) < 2:
        raise RuntimeError(f'표를 최소 2개 기대. 실제 {len(tbls)}개')

    tbl1, tbl2 = tbls[0], tbls[1]

    def _to_text(item):
        """항목이 dict 이면 title/text 뽑고, 문자열이면 그대로."""
        if isinstance(item, dict):
            return item.get('title') or item.get('text') or ''
        return str(item) if item is not None else ''

    if data.get('period'):
        set_cell_lines(get_cell(tbl1, 3, 1), [data['period']])
    if data.get('progress') is not None:
        set_cell_lines(get_cell(tbl1, 5, 1), [_to_text(x) for x in data['progress']])
    if data.get('planned') is not None:
        set_cell_lines(get_cell(tbl1, 6, 1), [_to_text(x) for x in data['planned']])
    # row 7 = 라벨 셀 (colSpan=2), row 8 = 값 셀 (colSpan=2, col 0)
    # 값 셀이 비어있어서 <t> template 없음 → 예정사항 셀에서 스타일 빌려옴
    if data.get('remarks') is not None:
        planned_cell = get_cell(tbl1, 6, 1)
        planned_paras = find_children(find_children(planned_cell, 'subList')[0], 'p')
        planned_template = None
        for p in planned_paras:
            if [t for t in p.iter() if local(t) == 't']:
                planned_template = p
                break
        set_cell_lines(get_cell(tbl1, 8, 0), [_to_text(x) for x in data['remarks']], fallback_template=planned_template)
    if data.get('work_items') is not None:
        if len(data['work_items']) == 0:
            # 빈 work_items → 헤더 유지 + 빈 데이터 행 1개 추가 (사용자가 hwp 로 열어 채울 수 있게)
            rebuild_work_items(tbl2, [{'no': '', 'title': '', 'details': [], 'status': '', 'memo': ''}])
        else:
            rebuild_work_items(tbl2, data['work_items'])

    tree.write(section_path, encoding='UTF-8', xml_declaration=True)


def main():
    if len(sys.argv) < 4:
        print('usage: hwpx_gen.py <template.hwpx> <output.hwpx> <data.json>', file=sys.stderr)
        sys.exit(2)

    template = sys.argv[1]
    output = sys.argv[2]
    data_path = sys.argv[3]

    with open(data_path, encoding='utf-8') as f:
        data = json.load(f)

    with tempfile.TemporaryDirectory(prefix='hwpx-') as work:
        with zipfile.ZipFile(template) as z:
            z.extractall(work)

        section_path = os.path.join(work, 'Contents', 'section0.xml')
        if not os.path.exists(section_path):
            print('Contents/section0.xml 없음 · 템플릿 이상', file=sys.stderr)
            sys.exit(2)

        apply(section_path, data)

        # 셀 문단 속성 정리:
        #   1) horizontal="JUSTIFY" → "LEFT" (양쪽 정렬 시 공백 늘어남 방지)
        #   2) breakNonLatinWord="BREAK_WORD" → "KEEP_WORD" (한글 단어 중간 잘림 방지)
        header_path = os.path.join(work, 'Contents', 'header.xml')
        if os.path.exists(header_path):
            with open(header_path, 'rb') as fh:
                hdr = fh.read()
            hdr2 = hdr.replace(b'horizontal="JUSTIFY"', b'horizontal="LEFT"')
            hdr2 = hdr2.replace(b'breakNonLatinWord="BREAK_WORD"', b'breakNonLatinWord="KEEP_WORD"')
            if hdr2 != hdr:
                with open(header_path, 'wb') as fh:
                    fh.write(hdr2)

        # 재압축 (mimetype은 STORED)
        if os.path.exists(output):
            os.remove(output)
        with zipfile.ZipFile(output, 'w') as zo:
            mimetype_path = os.path.join(work, 'mimetype')
            if os.path.exists(mimetype_path):
                zo.write(mimetype_path, 'mimetype', compress_type=zipfile.ZIP_STORED)
            for dp, _, files in os.walk(work):
                for fn in files:
                    full = os.path.join(dp, fn)
                    arcname = os.path.relpath(full, work).replace(os.sep, '/')
                    if arcname == 'mimetype':
                        continue
                    zo.write(full, arcname, compress_type=zipfile.ZIP_DEFLATED)

    print(json.dumps({'ok': True, 'output': output, 'size': os.path.getsize(output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
