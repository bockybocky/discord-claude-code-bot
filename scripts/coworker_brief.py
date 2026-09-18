# -*- coding: utf-8 -*-
"""Coworker delivery brief (ClawWork method, localized).

Work vs learn. Work needs an artifact. Learn must persist.
Not a GDPVal money sim, not a 15-round loop.
"""
from __future__ import annotations

import argparse
import re
import sys

INTENT_RE = re.compile(
    r"(ClawWork|同事模式|coworker|"
    r"這次要交檔|交作業|交付物|給我檔案路徑|做完交檔|"
    r"工作還是學習|先做還是先學|submit_work)",
    re.I,
)
LEARN_RE = re.compile(
    r"(記下來|學這個|寫進記憶|file-back|先學|learn\b)",
    re.I,
)
EQUITY_RE = re.compile(r"(該不該買|這檔|ticker|財報)", re.I)
SECRET_RE = re.compile(r"(中科院|機密)")


def is_coworker(text: str) -> bool:
    blob = text or ""
    if EQUITY_RE.search(blob) and not INTENT_RE.search(blob):
        return False
    return bool(INTENT_RE.search(blob))


def activity(text: str) -> str:
    return "learn" if LEARN_RE.search(text or "") else "work"


def format_brief(text: str) -> str:
    act = activity(text)
    secret = "yes" if SECRET_RE.search(text or "") else "no"
    lines = [
        "kind: coworker",
        f"activity: {act}",
        "work: 必須交出檔案路徑；沒檔＝沒交，不准用口頭充數",
        "learn: 要 <save-insight> 或明講沒寫進記憶；空話不算學到",
        "quality: 半成品標未交；不要假裝已完成",
        "loop: Discord 單次；禁止假裝日循環或 15 輪",
        "pay: 不准編造時薪、美金餘額、GDPVal 分數",
        "search: 真缺資料才搜；禁止空轉搜尋燒額度",
        f"secret: {secret}",
        "vs_c11: C11 是開源怎麼變現；本模式是這則要不要交檔",
        "install: 不准裝 ClawWork／nanobot",
        "",
        "rule: work=artifact, learn=persist, chat is not work.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_coworker("這次要交檔，做成報告")
    assert is_coworker("ClawWork 同事模式")
    assert not is_coworker("該不該買 NVDA")
    assert not is_coworker("今天有什麼新庫")
    assert activity("先學這個再記下來") == "learn"
    assert activity("這次要交檔") == "work"
    brief = format_brief("這次要交檔")
    assert "activity: work" in brief
    assert "不准編造時薪" in brief
    print("selftest ok")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("text", nargs="?")
    p.add_argument("--selftest", action="store_true")
    args = p.parse_args()
    if args.selftest:
        return run_selftest()
    blob = args.text or ""
    if not blob and not sys.stdin.isatty():
        blob = sys.stdin.read()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if not is_coworker(blob):
        print("not_coworker", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
