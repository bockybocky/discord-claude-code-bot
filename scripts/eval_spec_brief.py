# -*- coding: utf-8 -*-
"""Eval spec brief (LangChain eval-engineering method, localized).

Spec first, then task. Discord writes markdown specs only.
Does not install Harbor or eval-engineering. Does not run the benchmark.
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

NEST_DEFAULT = Path(r"D:\ai-memory\research\athena_insights\evals")

INTENT_RE = re.compile(
    r"(Vtrivedy|eval-engineering|"
    r"world\s*spec|task\s*spec|spec2task|"
    r"世界規格|任務規格|評測規格|"
    r"評測\s*Athena|Athena.{0,8}eval|"
    r"Harbor.{0,12}(?:任務|規格|eval)|"
    r"規格先於任務|先寫規格再)",
    re.I,
)
EQUITY_RE = re.compile(r"(該不該買|這檔|ticker|財報)", re.I)
ACCEPT_ONLY_RE = re.compile(r"(獨立驗收|行動清單|整理.{0,8}會議)", re.I)
WORLD_RE = re.compile(r"(world\s*spec|世界規格|共用規格)", re.I)
TASK2_RE = re.compile(
    r"(spec2task|Harbor\s*任務|建成評測|跑評測|生成.{0,6}Harbor)",
    re.I,
)
NOISE = re.compile(
    r"(幫我|帮我|Vtrivedy|eval-engineering|world\s*spec|task\s*spec|"
    r"spec2task|世界規格|任務規格|評測規格|評測\s*Athena|"
    r"Harbor|規格先於任務|先寫規格再|寫一份|写一份|寫|把)",
    re.I,
)
GENERIC_RE = re.compile(r"^(那套|這套|方法論|athenabot|athena)$", re.I)

WORLD_BODY = """# Athena world spec

這份是跨任務共用知識，不是單一任務。

## Agent
Discord Athena，oneshot，grok-4.6。沒有子代理、沒有 Harbor、沒有雲端電腦。

## Environment
腳本先注入 brief；模型只看卡片。現成模式是 C5–C20。

## Scoring default
能用機械檢查就不要 LLM-as-judge。檔在不在、雜湊、欄位、skip 值。

## Leak
任務說明不准寫答案。出現金標或 Answer placeholder＝規格壞了。

## Human
規格要他看過才准 Spec2Task。Discord 停在規格。
"""


def is_eval_spec(text: str) -> bool:
    blob = text or ""
    if EQUITY_RE.search(blob):
        return False
    if ACCEPT_ONLY_RE.search(blob) and not INTENT_RE.search(blob):
        return False
    return bool(INTENT_RE.search(blob))


def extract_title(text: str) -> str:
    blob = NOISE.sub(" ", text or "")
    blob = re.sub(r"https?://\S+", " ", blob)
    blob = " ".join(blob.split()).strip(" ：:「」\"'")
    if not blob or GENERIC_RE.match(blob):
        return "未命名任務"
    return blob[:60]


def slugify(title: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", title).strip("-")
    return s[:40] or "task"


def stage_of(text: str) -> str:
    blob = text or ""
    if TASK2_RE.search(blob):
        return "spec2task"
    if WORLD_RE.search(blob):
        return "world"
    return "task-spec"


def write_world(root: Path) -> tuple[str, bool]:
    dest = root / "world.md"
    dest.parent.mkdir(parents=True, exist_ok=True)
    created = not dest.exists()
    if created:
        dest.write_text(WORLD_BODY, encoding="utf-8", newline="\n")
    return str(dest.resolve()), created


def write_task_spec(title: str, root: Path) -> str:
    dest_dir = root / "specs"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{date.today().isoformat()}-{slugify(title)}.md"
    body = (
        f"# Task spec：{title}\n"
        f"\n"
        f"## Environment\n"
        f"沿用 world spec。這則多出來的環境：未指定。\n"
        f"\n"
        f"## Input\n"
        f"{title}\n"
        f"\n"
        f"## Scoring\n"
        f"機械：產出路徑存在；必填欄位在正文。不准只靠「看起來對」。\n"
        f"自由文才准 LLM-as-judge，且要寫清楚打什麼。\n"
        f"\n"
        f"## Stop\n"
        f"只到規格。不准建 Harbor 任務、不准跑評測、不准裝 eval-engineering。\n"
        f"難度先當偏易；他看過再加難，不要一次灌十個。\n"
    )
    dest.write_text(body, encoding="utf-8", newline="\n")
    return str(dest.resolve())


def maybe_write(text: str, root: Path | None = None) -> tuple[str, str]:
    root = root or NEST_DEFAULT
    stage = stage_of(text)
    if stage == "spec2task":
        world, _ = write_world(root)
        return stage, world
    if stage == "world":
        path, _ = write_world(root)
        return stage, path
    title = extract_title(text)
    write_world(root)
    return stage, write_task_spec(title, root)


def format_brief(text: str, artifact: str = "") -> str:
    stage = stage_of(text)
    title = extract_title(text)
    skip = "yes" if stage == "spec2task" else "no"
    lines = [
        "kind: eval-spec",
        f"stage: {stage}",
        f"title: {title}",
        "split: 先對齊規格，再談建任務；人看規格，不要看生出來的環境碼",
        "world: 跨任務共用（Athena oneshot、C 模式、機械打分）；單一任務細節放 task spec",
        "task: Environment／Input／Scoring 三塊；與 world 重複的不要再抄",
        "score: 表格式資料用腳本；自由文才 LLM-as-judge",
        "leak: 規格裡不准放答案",
        "easy: 第一份通常太簡單；他看過再加難",
        f"skip: {skip}",
        "reason: spec2task 回桌上；Discord 不跑 Harbor、不裝 eval-engineering、不掃 traces",
        f"artifact_path: {artifact or '（未寫檔）'}",
        "vs_c16: C16 是可重跑配方；本模式是評測規格",
        "vs_c17: C17 是建造流程；本模式是 benchmark 的規格／任務拆開",
        "vs_c20: C20 是這則文件驗收；本模式是以後怎麼反覆測",
        "",
        "rule: spec first; do not build the eval on Discord.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_eval_spec("寫評測規格 開源偵察漏項")
    assert is_eval_spec("world spec")
    assert is_eval_spec("Vtrivedy spec2task")
    assert not is_eval_spec("該不該買 NVDA")
    assert not is_eval_spec("獨立驗收 整理會議")
    assert not is_eval_spec("今天有什麼新庫")
    assert stage_of("world spec") == "world"
    assert stage_of("建成 Harbor 任務") == "spec2task"
    assert stage_of("寫評測規格 開源偵察") == "task-spec"
    tmp = Path(__file__).with_name("_tmp_evals")
    stage, path = maybe_write("寫評測規格 開源偵察漏項", tmp)
    assert stage == "task-spec"
    assert Path(path).exists() and "開源偵察" in Path(path).read_text(encoding="utf-8")
    world = tmp / "world.md"
    assert world.exists()
    Path(path).unlink(missing_ok=True)
    world.unlink(missing_ok=True)
    try:
        tmp.joinpath("specs").rmdir()
        tmp.rmdir()
    except OSError:
        pass
    brief = format_brief("Vtrivedy spec2task")
    assert "skip: yes" in brief
    assert "Harbor" in brief
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
    if not is_eval_spec(blob):
        print("not_eval_spec", file=sys.stderr)
        return 3
    _, artifact = maybe_write(blob)
    print(format_brief(blob, artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
