#!/usr/bin/env python3
"""ISO 주차 라벨. 초안 파일명(draft-2026-W33.json)과 직전 주차 탐색에 사용."""
from datetime import date, timedelta


def week_label(date_iso):
    y, w, _ = date.fromisoformat(date_iso).isocalendar()
    return f"{y}-W{w:02d}"


def prev_week_label(date_iso):
    d = date.fromisoformat(date_iso) - timedelta(days=7)
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"
