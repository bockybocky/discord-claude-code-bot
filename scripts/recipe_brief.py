# -*- coding: utf-8 -*-
"""Reusable recipe brief (aaif-goose method, localized).

Package instructions + params + success check. Not Goose desktop.
Not ghost_recipes (desktop click automation).
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

NEST_DEFAULT = Path(r"D:\ai-memory\research\athena_insights\recipes")

INTENT_RE = re.compile(
    r"(aaif-goose|goose\s*配方|goose\s*recipe|"
    r"做成\s*recipe|存成配方|可重跑這套|這次流程做成配方|"
    r"參數化流程|打包這套流程)",
    re.I,
)
GHOST_RE = re.compile(r"(ghost.?recipes?|UIA|元大同步|XQ\s*點擊|桌面點擊自動化)", re.I)
EQUITY_RE = re.compile(r"(該不該買|這檔|ticker|財報)", re.I)
NOISE = re.compile(
    r"(幫我|帮我|做成|存成|把|配方|recipe|goose|aaif-goose|"
    r"可重跑這套|這次流程|參數化流程|打包這套流程)",
    re.I,
)


def is_recipe(text: str) -> bool:
    blob = text or ""
    if GHOST_RE.search(blob) or EQUITY_RE.search(blob):
        return False
    return bool(INTENT_RE.search(blob))


def extract_title(text: str) -> str:
    blob = NOISE.sub(" ", text or "")
    blob = re.sub(r"https?://\S+", " ", blob)
    blob = " ".join(blob.split()).strip(" ：:「」\"'")
    return blob[:60] if blob else "未命名流程"


def slugify(title: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", title).strip("-")
    return (s[:40] or "recipe")


def write_yaml(title: str, dest: Path) -> Path:
    body = (
        f"version: \"1.0.0\"\n"
        f"title: \"{title.replace(chr(34), '')}\"\n"
        f"description: Discord 單次可重跑流程；參數代入後才跑。\n"
        f"instructions: |\n"
        f"  缺必填參數就停。檔案參數代入內容不是路徑。\n"
        f"  成功＝指定產物存在或指定字在正文裡。失敗就說失敗。\n"
        f"prompt: 依參數執行一次，不要開迴圈。\n"
        f"parameters: []\n"
        f"extensions: []\n"
        f"settings:\n"
        f"  max_turns: 1\n"
        f"# keys: 不含密鑰。trust: 第一次先講會做什麼。\n"
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(body, encoding="utf-8", newline="\n")
    return dest


def maybe_write(text: str, root: Path | None = None) -> str:
    root = root or NEST_DEFAULT
    title = extract_title(text)
    name = f"{date.today().isoformat()}-{slugify(title)}.yaml"
    return str(write_yaml(title, root / name).resolve())


def format_brief(text: str, artifact: str = "") -> str:
    title = extract_title(text)
    lines = [
        "kind: recipe",
        f"title: {title}",
        "shape: title + instructions + prompt；至少要有指示或開場句",
        "params: 必填無預設；選填必有預設；檔案參數代入內容不是路徑，不准給預設路徑",
        "extensions: 只列這次要用的模式／腳本，不要全開",
        "success: 一條機械檢查（檔在不在／字在不在），不是看起來對",
        "retry: Discord 單次；失敗就說失敗，禁止空轉",
        "max_turns: 1",
        "keys: 配方不含密鑰與全域記憶",
        "trust: 第一次跑未知配方先講會做什麼",
        f"artifact_path: {artifact or '（未寫檔）'}",
        "install: 不准裝 goose desktop／CLI",
        "vs_ghost: 桌面點擊自動化走 ghost_recipes，不是這條",
        "",
        "rule: package a repeatable flow; validate mechanically.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_recipe("把這次流程做成配方")
    assert is_recipe("aaif-goose recipe")
    assert not is_recipe("該不該買 NVDA")
    assert not is_recipe("元大同步 UIA 配方")
    tmp = Path(__file__).with_name("_tmp_recipe.yaml")
    p = maybe_write("存成配方 晨報摘要", tmp.parent)
    assert Path(p).exists() and p.endswith(".yaml")
    Path(p).unlink(missing_ok=True)
    brief = format_brief("存成配方 晨報摘要")
    assert "max_turns: 1" in brief
    assert "ghost_recipes" in brief
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
    if not is_recipe(blob):
        print("not_recipe", file=sys.stderr)
        return 3
    artifact = maybe_write(blob)
    print(format_brief(blob, artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
