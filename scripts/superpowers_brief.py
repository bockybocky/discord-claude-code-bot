# -*- coding: utf-8 -*-
"""Build-process brief (obra/superpowers method, localized).

Brainstorm → plan → evidence. Discord oneshot cannot run the full loop.
Does not install Superpowers. Does not spawn subagents.
"""
from __future__ import annotations

import argparse
import re
import sys

INTENT_RE = re.compile(
    r"(superpowers|"
    r"先想清楚再寫|腦力激盪設計|brainstorm|"
    r"先寫測試|RED.?GREEN|TDD|"
    r"系統除錯|systematic.?debug|"
    r"還沒驗不准說|verification.before|"
    r"寫這個功能|實作這個|修這個\s*bug|拆實作計畫)",
    re.I,
)
EQUITY_RE = re.compile(r"(該不該買|這檔|ticker|財報)", re.I)
DEBUG_RE = re.compile(r"(bug|壞了|沒動|除錯|debug|為什麼沒)", re.I)
VERIFY_RE = re.compile(r"(驗過|測過|修好了嗎|真的修好|verify)", re.I)
PLAN_RE = re.compile(r"(拆實作計畫|寫計畫|實作計畫|writing-plans)", re.I)
IMPLEMENT_RE = re.compile(r"(實作這個|寫這個功能|TDD|先寫測試|RED.?GREEN)", re.I)
BRAIN_RE = re.compile(r"(先想清楚|腦力激盪|brainstorm|superpowers)", re.I)


def is_superpowers(text: str) -> bool:
    blob = text or ""
    if EQUITY_RE.search(blob):
        return False
    return bool(INTENT_RE.search(blob))


def stage_of(text: str) -> str:
    blob = text or ""
    if DEBUG_RE.search(blob):
        return "debug"
    if VERIFY_RE.search(blob):
        return "verify"
    if PLAN_RE.search(blob):
        return "plan"
    if IMPLEMENT_RE.search(blob) and not BRAIN_RE.search(blob):
        return "implement"
    if BRAIN_RE.search(blob):
        return "brainstorm"
    if IMPLEMENT_RE.search(blob):
        return "implement"
    return "brainstorm"


def format_brief(text: str) -> str:
    stage = stage_of(text)
    lines = [
        "kind: superpowers-process",
        f"stage: {stage}",
        "order: 腦力激盪 → 分段設計給他看 → 計畫（路徑＋驗證）→ 實作；不准跳步寫碼",
        "tdd: 先有會失敗的檢查，再寫剛好讓它過的東西；沒檢查不准說寫完",
        "evidence: 沒貼測試／指令輸出，不准宣稱修好或完成",
        "debug: 先建可重跑的失敗訊號，不要靠猜",
        "discord: 單次只停在目前 stage；實作與子代理在桌上 CC／codex",
        "subagent: Discord 沒有子代理，不准假裝開了",
        "yagni: 計畫給品味差的初級工程師也能跟；不要加用不到的",
        "install: Superpowers 已在桌上 harness；不准在 Discord 再裝一套",
        "vs_c15: C15 是這則要不要交檔；本模式是建造流程有沒有跳步",
        "vs_c16: C16 是可重跑配方；本模式是這次建造怎麼走",
        "",
        "rule: process over guessing; evidence over claims.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_superpowers("先想清楚再寫這個功能")
    assert is_superpowers("修這個 bug，系統除錯")
    assert not is_superpowers("該不該買 NVDA")
    assert not is_superpowers("今天有什麼新庫")
    assert stage_of("修這個 bug") == "debug"
    assert stage_of("拆實作計畫") == "plan"
    assert stage_of("superpowers 幫我設計") == "brainstorm"
    assert stage_of("先想清楚再寫這個功能") == "brainstorm"
    brief = format_brief("先寫測試再實作這個")
    assert "stage: implement" in brief
    assert "子代理" in brief
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
    if not is_superpowers(blob):
        print("not_superpowers", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
