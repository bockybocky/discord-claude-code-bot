# -*- coding: utf-8 -*-
"""Classify sourced-writing intent (mathbullet/skills, localized).

Assertion then evidence. No bare [1]. No fabricated links.
Does not write Markdown reports or HTML.
"""
from __future__ import annotations

import argparse
import re
import sys

SURVEY_RE = re.compile(
    r"(調查|调查|彙整|汇总|多篇來源|多源|有哪些人講|有哪些人讲|"
    r"蒐集來源|收集来源|survey|索引報告)",
    re.I,
)
EXPLAIN_RE = re.compile(
    r"(解釋這|解释这|什麼是.{0,16}(?:機制|机制|原理|架構|架构)|"
    r"怎麼運作|怎么运作|概念解釋|讲清楚这个|講清楚這個)",
    re.I,
)
QUOTE_RE = re.compile(r"(出處|出处|引用原文|原句|典據|根据哪|根據哪|有沒有出處)")
INTENT_RE = re.compile(
    r"(調查|调查|彙整|多篇來源|多源|出處|出处|引用原文|典據|"
    r"解釋這|什么是.{0,12}机制|什麼是.{0,12}機制|怎麼運作|survey)",
    re.I,
)


def is_sourced(text: str) -> bool:
    return bool(INTENT_RE.search(text or ""))


def classify(text: str) -> str:
    blob = text or ""
    if SURVEY_RE.search(blob):
        return "survey"
    if EXPLAIN_RE.search(blob):
        return "explain"
    if QUOTE_RE.search(blob):
        return "quote"
    return "sourced"


def format_brief(text: str) -> str:
    kind = classify(text)
    lines = [
        f"kind: {kind}",
        "order: claim → quote → [label (YYYY/MM)]",
        "cite_form: [label (YYYY/MM), location]  禁止裸 [1][2]",
        "quote_form: 原句用引號另起一行；翻譯可跟在原句下。Discord 不要表格、不要長 code fence",
        "fact_rule: 每條事實要出處；掛不上就寫未核對。禁止「眾所周知」無源斷定",
        "split: 來源原意 vs 你的判斷。來源沒寫的持股聯想標「判斷，來源未寫」",
        "numbers: 數字必帶單位＋分母＋範圍",
        "terms: 術語／縮寫初出先定義一句",
        "tier: 同儕審查論文 > 官方 > 專業媒體 > 個人部落格；官文與二手不要混成同一可信度",
    ]
    if kind == "survey":
        lines.extend(
            [
                "survey: 主張→原句→來源；結尾列來源清單 [label, YYYY/MM] 作者. 標題. 出處. URL",
                "limits: 找不到的、沒核到的 URL，寫進調查限度，不准補腦",
            ]
        )
    if kind == "explain":
        lines.extend(
            [
                "explain: 詞定義 → 為什麼需要 → 機制 → 例子 → 現況",
                "explain_ban: 不要 mermaid、不要表格；一步因果寫清楚",
            ]
        )
    if kind == "quote":
        lines.append("quote: 只引輸入裡有的句子；頁碼沒讀到 PDF 就不要編")
    lines.extend(
        [
            "",
            "rule: assertion first, then evidence. Do not fabricate associations.",
            "Paper CHEAP path still quotes abstract only; no fake page numbers.",
        ]
    )
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_sourced("幫我調查 HBM 有哪些人在講")
    assert classify("幫我調查 HBM 有哪些人在講") == "survey"
    assert classify("解釋這個注意力機制怎麼運作") == "explain"
    assert classify("這句出處在哪") == "quote"
    assert not is_sourced("今天吃什麼")
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
    if not is_sourced(blob):
        print("not_sourced", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
