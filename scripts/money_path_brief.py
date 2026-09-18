# -*- coding: utf-8 -*-
"""Open-source money-path brief.

Method from garylab/MakeMoneyWithAI: one sentence on how a repo's
capacity turns into income. Not a star dump, not a 400-item list.
"""
from __future__ import annotations

import argparse
import re
import sys

INTENT_RE = re.compile(
    r"(MakeMoneyWithAI|開源變現|開源赚钱|"
    r"這庫.{0,10}(?:賺錢|赚钱|變現|变现|能賣|能卖)|"
    r"這\s*repo.{0,10}(?:賺錢|赚钱|變現|变现)|"
    r"(?:開源|这库|這庫|github).{0,16}(?:商業模式|商业模式|做成產品|做成产品)|"
    r"monetize.{0,24}(?:open.?source|github|repo)|"
    r"怎麼用.{0,16}開源.{0,8}(?:賺錢|赚钱)|"
    r"github\.com/\S+.{0,40}(?:賺錢|赚钱|變現|变现|monetize|能賣|能卖))",
    re.I,
)
EQUITY_RE = re.compile(
    r"(該不該買|该不该买|這檔|这档|這支股|这支股|持倉|持仓|ticker|財報|财报)",
    re.I,
)
REPO_URL_RE = re.compile(
    r"github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)",
    re.I,
)
REPO_SHORT_RE = re.compile(
    r"\b([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)\b",
)
SKIP_RE = re.compile(
    r"(awesome[-_ ]|cookbook|course|tutorial|interview|roadmap|"
    r"for-beginners|githubdaily|learning-resources|notes$|ml-course)",
    re.I,
)
HARM_RE = re.compile(
    r"(deepfake|face-?swap|換臉|换脸|voice-?clon|人聲克隆|人声克隆)",
    re.I,
)
PATHS = [
    ("saas", r"saas|訂閱|订阅|subscription"),
    ("api", r"\bapi\b|用量|inference|serving|gateway"),
    ("onprem", r"白牌|地端|self-host|on-?prem|white-?label"),
    ("consult", r"顧問|顾问|訓練|训练|consult|training"),
    ("market", r"外掛|plugin|marketplace|市集"),
]


def is_money_path(text: str) -> bool:
    blob = text or ""
    if EQUITY_RE.search(blob) and not REPO_URL_RE.search(blob) and "開源" not in blob and "这库" not in blob and "這庫" not in blob:
        return False
    return bool(INTENT_RE.search(blob))


def parse_repo(text: str) -> str:
    blob = text or ""
    m = REPO_URL_RE.search(blob)
    if m:
        return f"{m.group(1)}/{m.group(2).rstrip('.,)/')}"
    m = REPO_SHORT_RE.search(blob)
    if m and m.group(1).lower() not in {"http", "https", "www"}:
        name = m.group(2).rstrip(".,)/")
        if "." not in name or name.endswith(".js"):
            return f"{m.group(1)}/{name}"
    return "unspecified"


def skip_reason(text: str) -> str:
    blob = text or ""
    repo = parse_repo(blob)
    hay = f"{blob} {repo}"
    if HARM_RE.search(hay):
        return "harm"
    if SKIP_RE.search(hay):
        return "tutorial-or-list"
    return "none"


def parse_path(text: str) -> str:
    blob = (text or "").lower()
    hits = [name for name, pat in PATHS if re.search(pat, blob, re.I)]
    return hits[0] if hits else "unspecified"


def format_brief(text: str) -> str:
    repo = parse_repo(text)
    skip = skip_reason(text)
    path = parse_path(text)
    lines = [
        "kind: money-path",
        f"repo: {repo}",
        f"skip: {skip}",
        f"path_hint: {path}",
        "line: 能力一句 → 錢路一句；只選一條主路（SaaS／API／白牌／顧問／市集）",
        "bar: 不是星數榜；一年沒推送當過期；禁教程／awesome／課程／面試筆記",
        "harm: 換臉、未授權人聲、deepfake 直接跳過",
        "quota: 最多三則；湊不滿就少講",
        "company: 不預設要做成產品；對公司有用才點名哪一條，否則只學錢路",
        "numbers: 不准編營收、不准編付費人數",
        "vs_c9: C9 講能做什麼；本模式只講錢從哪來",
        "",
        "rule: turn open-source capacity into one income sentence.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_money_path("n8n-io/n8n 這庫怎麼賺錢")
    assert is_money_path("MakeMoneyWithAI 那種開源變現")
    assert is_money_path("https://github.com/n8n-io/n8n 能賣嗎")
    assert not is_money_path("該不該買 NVDA")
    assert not is_money_path("今天有什麼新庫")
    assert not is_money_path("這檔怎麼賺錢")
    assert parse_repo("看 https://github.com/n8n-io/n8n 這庫怎麼賺錢") == "n8n-io/n8n"
    assert skip_reason("awesome-chatgpt-prompts 開源變現") == "tutorial-or-list"
    assert skip_reason("Deep-Live-Cam 換臉 這庫怎麼賺錢") == "harm"
    brief = format_brief("ollama/ollama 這庫怎麼做白牌賺錢")
    assert "repo: ollama/ollama" in brief
    assert "path_hint: onprem" in brief
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
    if not is_money_path(blob):
        print("not_money_path", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
