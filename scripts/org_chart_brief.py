# -*- coding: utf-8 -*-
"""Org-chart brief (cyrilXBT / Grok Bot department method, localized).

One box at a time. Executive never staffed. Not five Discord bots.
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

NEST_DEFAULT = Path(r"D:\ai-memory\research\athena_insights\org")

INTENT_RE = re.compile(
    r"(cyrilXBT|"
    r"組織圖|org\s*chart|"
    r"下一個部門|編制部門|編制.{0,16}部門|部門記分卡|"
    r"銷售部門|行銷部門|工程部門|"
    r"執行長功能|策略留給我|"
    r"一次開五個部門|不要一次開齊|"
    r"這個部門證明了|部門證明|"
    r"staff.{0,12}department)",
    re.I,
)
EQUITY_RE = re.compile(r"(該不該買|這檔|ticker|財報)", re.I)
LEAD_ONLY_RE = re.compile(r"(該建哪個機器人|開一個機器人|lead\s*bot)", re.I)
ROSTER_ONLY_RE = re.compile(r"(人設檔|兩清單|WHAT I PULL)", re.I)
SALES_RE = re.compile(r"(銷售|開發信|LinkedIn|outreach|prospect)", re.I)
PUBLIC_RE = re.compile(r"(行銷部門|對外發文|社群排程|品牌定位)", re.I)
ENG_RE = re.compile(r"(工程部門|維護程式|改 codebase)", re.I)
EXEC_RE = re.compile(r"(執行長|策略留給|部位|花錢|對外發布)", re.I)
SCORE_RE = re.compile(r"(記分卡|hours\s*saved|信任在漲)", re.I)
NEXT_RE = re.compile(r"(下一個部門|加第二個部門|開齊)", re.I)
ORG_RE = re.compile(r"(組織圖|org\s*chart)", re.I)
NOISE = re.compile(
    r"(幫我|帮我|畫一張|畫張|畫個|cyrilXBT|組織圖|org\s*chart|下一個部門|編制部門|"
    r"部門記分卡|執行長功能|策略留給我|一次開五個部門|不要一次開齊|"
    r"這個部門證明了|部門證明|staff|department|寫一份|寫|把)",
    re.I,
)
GENERIC_RE = re.compile(r"^(那套|這套|方法論|athenabot|athena|部門)$", re.I)

ORG_BODY = """# Athena 組織圖（一格，不是五個機器人）

Athena 仍是一個 Discord 入口。格子＝現成模式，不是新開的帳號。

- 開源偵察：C9
- 交檔：C15
- 人設檔：C18
- 總管路由：C19
- 獨立驗收：C20
- 評測規格：C21

## 執行長（永遠不交）
部位、花錢、對外發布、偏好。這些格子不設機器人。

## 順序
一次一格。沒證明第一個，不准加第二個。
"""


def is_org(text: str) -> bool:
    blob = text or ""
    if EQUITY_RE.search(blob):
        return False
    if LEAD_ONLY_RE.search(blob) and not INTENT_RE.search(blob):
        return False
    if ROSTER_ONLY_RE.search(blob) and not INTENT_RE.search(blob):
        return False
    return bool(INTENT_RE.search(blob))


def extract_name(text: str) -> str:
    blob = NOISE.sub(" ", text or "")
    blob = re.sub(r"https?://\S+", " ", blob)
    blob = " ".join(blob.split()).strip(" ：:「」\"'")
    if not blob or GENERIC_RE.match(blob):
        return "未命名部門"
    return blob[:60]


def slugify(title: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", title).strip("-")
    return s[:40] or "dept"


def stage_of(text: str) -> str:
    blob = text or ""
    if SCORE_RE.search(blob):
        return "scorecard"
    if SALES_RE.search(blob):
        return "skip_sales"
    if PUBLIC_RE.search(blob):
        return "park_public"
    if ENG_RE.search(blob):
        return "eng_desktop"
    if EXEC_RE.search(blob) and not ORG_RE.search(blob):
        return "never_staff"
    if NEXT_RE.search(blob):
        return "prove_first"
    if ORG_RE.search(blob):
        return "org"
    return "one_box"


def skip_of(stage: str) -> str:
    if stage in {"skip_sales", "park_public", "never_staff", "prove_first", "eng_desktop"}:
        return "yes"
    return "no"


def reason_of(stage: str) -> str:
    return {
        "skip_sales": "不是他每週的活，不要抄銷售開發信部門",
        "park_public": "對外發文／品牌定位是執行長格，停車",
        "eng_desktop": "改程式回桌上 C17，不是新 Discord 工程機器人",
        "never_staff": "執行長格永遠不交：部位／花錢／對外／偏好",
        "prove_first": "第一格沒證明，不准加第二格",
        "scorecard": "時數與修改量要實測；不准填樂觀估計",
        "org": "格子＝現成 C 模式；不准新開 Discord 機器人",
        "one_box": "只編這一格：職務、成功、向誰報告",
    }.get(stage, "一次一格")


def write_org(root: Path) -> tuple[str, bool]:
    dest = root / "org.md"
    dest.parent.mkdir(parents=True, exist_ok=True)
    created = not dest.exists()
    if created:
        dest.write_text(ORG_BODY, encoding="utf-8", newline="\n")
    return str(dest.resolve()), created


def write_box(name: str, stage: str, root: Path) -> str:
    dest_dir = root
    dest_dir.mkdir(parents=True, exist_ok=True)
    if stage == "scorecard":
        dest = dest_dir / f"{date.today().isoformat()}-記分卡.md"
        body = (
            f"# 部門記分卡 {date.today().isoformat()}\n"
            f"\n"
            f"- hours: 未量（對人手做的真實時數，不准填樂觀估計）\n"
            f"- edits: 未量（他改了多少才堪用）\n"
            f"- trust: 未評（漲／平／掉）\n"
            f"\n"
            f"沒量就寫未量。不准用訂閱價或代言數字充數。\n"
        )
        dest.write_text(body, encoding="utf-8", newline="\n")
        return str(dest.resolve())
    dest = dest_dir / f"{date.today().isoformat()}-{slugify(name)}.md"
    body = (
        f"# 部門：{name}\n"
        f"\n"
        f"- 職務：只做這一格\n"
        f"- 成功：產出可核對；沒有就說沒有\n"
        f"- 向誰報告：Charles。策略／部位／花錢／對外不交\n"
        f"- 工具：窄，對應現成 C 模式，不准新開 Discord 機器人\n"
        f"- 下一格：這一格沒證明之前不准加\n"
    )
    dest.write_text(body, encoding="utf-8", newline="\n")
    return str(dest.resolve())


def maybe_write(text: str, root: Path | None = None) -> tuple[str, str]:
    root = root or NEST_DEFAULT
    stage = stage_of(text)
    if stage in {"skip_sales", "park_public", "never_staff", "prove_first", "eng_desktop"}:
        path, _ = write_org(root)
        return stage, path
    if stage == "org":
        path, _ = write_org(root)
        return stage, path
    write_org(root)
    return stage, write_box(extract_name(text), stage, root)


def format_brief(text: str, artifact: str = "") -> str:
    stage = stage_of(text)
    name = extract_name(text)
    lines = [
        "kind: org-chart",
        f"stage: {stage}",
        f"dept: {name}",
        f"skip: {skip_of(stage)}",
        f"reason: {reason_of(stage)}",
        "exec: 策略／部位／花錢／對外永遠不交",
        "order: 一次一格；證明了才加下一格",
        "access: 工具範圍要窄，不准為了省事開全域登入",
        "score: 時數／修改量／信任；沒量就寫未量",
        "bots: 不准新開 Discord 機器人；格子＝現成 C 模式",
        f"artifact_path: {artifact or '（未寫檔）'}",
        "vs_c18: C18 是人設檔四塊；本模式是組織順序與執行長邊界",
        "vs_c19: C19 是先取名、一次性不建；本模式是一次一格、證明了再加",
        "",
        "rule: staff one box; never staff the owner.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_org("畫一張組織圖")
    assert is_org("cyrilXBT 下一個部門")
    assert is_org("部門記分卡")
    assert is_org("銷售部門開發信")
    assert not is_org("該不該買 NVDA")
    assert not is_org("今天有什麼新庫")
    assert not is_org("寫人設檔 每日開源偵察")
    assert not is_org("該建哪個機器人")
    assert extract_name("畫一張組織圖") == "未命名部門"
    assert stage_of("畫一張組織圖") == "org"
    assert stage_of("下一個部門") == "prove_first"
    assert stage_of("銷售部門開發信") == "skip_sales"
    assert stage_of("執行長功能交給機器人") == "never_staff"
    tmp = Path(__file__).with_name("_tmp_org")
    stage, path = maybe_write("畫一張組織圖", tmp)
    assert stage == "org"
    assert Path(path).exists() and "執行長" in Path(path).read_text(encoding="utf-8")
    Path(path).unlink(missing_ok=True)
    try:
        tmp.rmdir()
    except OSError:
        pass
    brief = format_brief("下一個部門")
    assert "skip: yes" in brief
    assert "一次一格" in brief
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
    if not is_org(blob):
        print("not_org", file=sys.stderr)
        return 3
    _, artifact = maybe_write(blob)
    print(format_brief(blob, artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
