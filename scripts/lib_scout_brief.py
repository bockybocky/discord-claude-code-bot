# -*- coding: utf-8 -*-
"""Editorial scout brief (GitHubDaily method, localized).

Curate, don't rank by stars. One-line what it does. Skip already-seen.
"""
from __future__ import annotations

import argparse
import re
import sys

INTENT_RE = re.compile(
    r"(新庫|開源偵察|開源推薦|推薦開源|GitHubDaily|有什麼新的\s*repo|"
    r"今天有什麼新庫|有沒有新的開源)",
    re.I,
)


def is_scout(text: str) -> bool:
    return bool(INTENT_RE.search(text or ""))


def format_brief(text: str) -> str:
    del text
    return "\n".join(
        [
            "kind: editorial-scout",
            "bar: 高品質＋有趣實用，不是星數榜、不是 skill 打包清單",
            "line: 一句話講「能做什麼」，再可選對公司哪一條",
            "dedup: 已介紹過的（含同系列改版）不重提",
            "quota: 一天最多三則；湊不滿就少貼；沒有新的就說今天沒有",
            "install: 不預設要裝；學方法論優先",
            "source: 用最近偵察底稿或 x_search／已知庫，不准編造 repo",
            "",
            "rule: GitHubDaily curate-not-aggregate. Empty day = no post.",
        ]
    )


def run_selftest() -> int:
    assert is_scout("今天有什麼新庫")
    assert is_scout("GitHubDaily 那種開源推薦")
    assert not is_scout("該不該買 NVDA")
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
    if not is_scout(blob):
        print("not_scout", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
