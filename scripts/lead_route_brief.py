# -*- coding: utf-8 -*-
"""Lead-route brief (Mahaximus / Grok Bot method, localized).

Name the job first. Skip one-off roles. Route to existing C-modes.
Do not spawn Discord bots. Do not pretend the cloud computer stays on.
"""
from __future__ import annotations

import argparse
import re
import sys

INTENT_RE = re.compile(
    r"(Mahaximus|"
    r"lead\s*bot|總管機器人|領隊機器人|協調機器人|"
    r"該建哪個機器人|該開哪個\s*bot|先建哪個機器人|"
    r"開一個機器人|建一個機器人|建一個\s*bot|"
    r"開一個.{0,24}機器人|"
    r"先取名|名字太模糊|"
    r"一次性就不要建|不要建機器人|"
    r"最明顯有用|"
    r"會議簡報機器人|meeting\s*brief|"
    r"first\s*draft\s*agent|"
    r"睡覺還在跑|關機還跑|關對話還)",
    re.I,
)
EQUITY_RE = re.compile(r"(該不該買|這檔|ticker|財報)", re.I)
ROSTER_FILE_RE = re.compile(r"(人設檔|角色檔|兩清單|WHAT I PULL)", re.I)
SCOUT_ONLY_RE = re.compile(r"(今天有什麼新庫|有沒有新的開源|GitHubDaily)", re.I)
LINKEDIN_RE = re.compile(r"(LinkedIn|開發信|prospecting|outreach|銷售開發)", re.I)
CLOUD_RE = re.compile(r"(睡覺還在跑|關機還跑|關對話還|雲端電腦|cloud computer)", re.I)
ONCE_RE = re.compile(r"(這一次|一次性|只要這次|這則就好|不要建)", re.I)
RECUR_RE = re.compile(r"(每週|每天|每日|每次開會|固定|一直跑|持續)", re.I)
FIRST_HIRE_RE = re.compile(r"(該建哪個|該開哪個|先建哪個|最明顯有用)", re.I)
SCOUT_RE = re.compile(r"(新庫|開源偵察|偵察)", re.I)
DRAFT_RE = re.compile(r"(初稿|語音.{0,6}稿|筆記.{0,6}稿|first\s*draft)", re.I)
MEET_RE = re.compile(r"(會議簡報|meeting\s*brief|開會前)", re.I)
REVIEW_RE = re.compile(r"(review\s*monitor|評價監控|競品評價)", re.I)
VAGUE_RE = re.compile(r"^(助理|萬能|幫忙|處理|機器人|bot|agent|角色)$", re.I)
GENERIC_RE = re.compile(
    r"^(那套|這套|學那套|方法論|應用|athenabot|athena)$",
    re.I,
)
NOISE = re.compile(
    r"(幫我|帮我|開一個|建一個|該建哪個|該開哪個|先建哪個|"
    r"機器人|bot|agent|lead|總管|領隊|協調|"
    r"Mahaximus|先取名|名字太模糊|最明顯有用|"
    r"一次性就不要建|不要建)",
    re.I,
)


def is_lead(text: str) -> bool:
    blob = text or ""
    if EQUITY_RE.search(blob):
        return False
    if ROSTER_FILE_RE.search(blob) and not INTENT_RE.search(blob):
        return False
    if SCOUT_ONLY_RE.search(blob) and not INTENT_RE.search(blob):
        return False
    return bool(INTENT_RE.search(blob))


def extract_name(text: str) -> str:
    blob = NOISE.sub(" ", text or "")
    blob = re.sub(r"https?://\S+", " ", blob)
    blob = " ".join(blob.split()).strip(" ：:「」\"'")
    if not blob or GENERIC_RE.match(blob) or VAGUE_RE.match(blob):
        return "未命名"
    return blob[:60]


def cadence_of(text: str) -> str:
    blob = text or ""
    if ONCE_RE.search(blob):
        return "one-off"
    if RECUR_RE.search(blob):
        return "recurring"
    return "unknown"


def name_ok(name: str) -> bool:
    return name != "未命名" and not VAGUE_RE.match(name)


def route_of(text: str, name: str) -> str:
    blob = text or ""
    if LINKEDIN_RE.search(blob):
        return "skip_not_week"
    if CLOUD_RE.search(blob):
        return "skip_cloud"
    if FIRST_HIRE_RE.search(blob):
        return "first_hire"
    if cadence_of(blob) == "one-off":
        return "oneshot"
    if SCOUT_RE.search(blob):
        return "C9"
    if DRAFT_RE.search(blob):
        return "C15"
    if MEET_RE.search(blob):
        return "meeting_brief"
    if REVIEW_RE.search(blob):
        return "skip_cc_audit"
    if not name_ok(name):
        return "name_first"
    if cadence_of(blob) == "recurring":
        return "C18"
    return "oneshot"


def skip_of(route: str) -> str:
    if route in {
        "skip_not_week",
        "skip_cloud",
        "oneshot",
        "name_first",
        "skip_cc_audit",
        "meeting_brief",
    }:
        return "yes"
    return "no"


def reason_of(route: str) -> str:
    return {
        "skip_not_week": "不是他每週的工作，不要抄 LinkedIn 開發信",
        "skip_cloud": "Discord 單次，關對話就停，不准假裝還在跑",
        "oneshot": "一次性不要建角色，這則直接做",
        "name_first": "名字太模糊＝角色模糊；先取一個職務名",
        "skip_cc_audit": "評價／持股巡視走桌上 CC，不是新 Discord 機器人",
        "meeting_brief": "開會前一頁直接做；不要為此新開機器人",
        "first_hire": "先建最明顯、每週重複、產出清楚的那個",
        "C9": "開源偵察已有 C9，不要第二個偵察機器人",
        "C15": "初稿＝交檔，走 C15，不是新機器人",
        "C18": "每週重複且名字清楚→寫人設檔（C18），仍是同一個 Athena",
    }.get(route, "這則一次做完")


def format_brief(text: str) -> str:
    name = extract_name(text)
    route = route_of(text, name)
    lines = [
        "kind: lead-route",
        f"name: {name}",
        f"name_ok: {'yes' if name_ok(name) else 'no'}",
        f"cadence: {cadence_of(text)}",
        f"route: {route}",
        f"skip: {skip_of(route)}",
        f"reason: {reason_of(route)}",
        "first_hire: 每週重複＋產出清楚。現成＝每日開源偵察（C9）。下一步常是語音／筆記→初稿。不要從開發信開始",
        "lead: Athena 已是總管；專精＝既有 C 模式，不准新開 Discord 機器人",
        "undo: 可還原的自己做完；外面看得到／花錢／刪除→停車",
        "cloud: Discord 單次；不准裝 Grok Bot 雲端電腦、不准共用登入",
        "output: 要交的東西寫進檔，不要只停在聊天窗",
        "vs_c18: C18 是寫人設檔；本模式是先取名、決定要不要建、指到哪個現成模式",
        "vs_c15: C15 是這則交不交檔；本模式是要不要為此設一個角色",
        "",
        "rule: name the job, skip one-offs, route to what already exists.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_lead("該建哪個機器人")
    assert is_lead("開一個會議簡報機器人")
    assert is_lead("開一個 LinkedIn 開發機器人")
    assert is_lead("Mahaximus lead bot")
    assert is_lead("開一個機器人只要這一次")
    assert not is_lead("該不該買 NVDA")
    assert not is_lead("今天有什麼新庫")
    assert not is_lead("寫人設檔 每日開源偵察")
    assert not is_lead("先想清楚再寫這個功能")
    assert extract_name("開一個會議簡報機器人") == "會議簡報"
    assert extract_name("開一個機器人") == "未命名"
    assert route_of("開一個 LinkedIn 開發機器人", "LinkedIn 開發") == "skip_not_week"
    assert route_of("該建哪個機器人", "未命名") == "first_hire"
    assert route_of("開一個機器人只要這一次", "未命名") == "oneshot"
    brief = format_brief("該建哪個機器人")
    assert "kind: lead-route" in brief
    assert "不准新開 Discord 機器人" in brief
    assert "C9" in brief
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
    if not is_lead(blob):
        print("not_lead", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
