# -*- coding: utf-8 -*-
"""Independent-accept brief (xiaomovps / Pi first-task method, localized).

Material + action + limit + accept. Do not trust "done".
Does not install Pi. Does not sandbox the OS.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from datetime import date
from pathlib import Path

NEST_DEFAULT = Path(r"D:\ai-memory\research\athena_insights\accept")

INTENT_RE = re.compile(
    r"(xiaomovps|"
    r"獨立驗收|行动清单|行動清單|"
    r"整理.{0,8}會議|整理.{0,8}会议|"
    r"會議記錄.{0,20}清單|会议记录.{0,20}清单|"
    r"不要信.{0,8}完成|不要改原檔|不要改原档|"
    r"input\s*只讀|input\s*只读|"
    r"材料.{0,4}動作.{0,4}限制.{0,4}驗收|"
    r"材料.{0,4}动作.{0,4}限制.{0,4}验收|"
    r"SHA-256.{0,16}(?:原檔|原档|輸入|输入))",
    re.I,
)
EQUITY_RE = re.compile(r"(該不該買|這檔|ticker|財報)", re.I)
LEAD_ONLY_RE = re.compile(r"(該建哪個機器人|開一個機器人|lead\s*bot)", re.I)
NOISE = re.compile(
    r"(幫我|帮我|xiaomovps|獨立驗收|行动清单|行動清單|"
    r"整理成|整理|不要信已完成|不要改原檔|不要改原档|"
    r"input\s*只讀|input\s*只读|"
    r"https?://\S+)",
    re.I,
)
OWNER_RE = re.compile(r"負責人[:：]\s*([^\s，,；;]+)")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日")
RISK_RE = re.compile(r"風險")
MIN_BODY = 80


def is_accept(text: str) -> bool:
    blob = text or ""
    if EQUITY_RE.search(blob):
        return False
    if LEAD_ONLY_RE.search(blob) and not INTENT_RE.search(blob):
        return False
    return bool(INTENT_RE.search(blob))


def extract_body(text: str) -> str:
    blob = NOISE.sub(" ", text or "")
    blob = " ".join(blob.split()).strip(" ：:「」\"'")
    return blob


def harvest(body: str) -> tuple[list[str], list[str], int]:
    owners = OWNER_RE.findall(body or "")[:8]
    dates = DATE_RE.findall(body or "")[:8]
    risks = len(RISK_RE.findall(body or ""))
    return owners, dates, risks


def sha256_text(body: str) -> str:
    return hashlib.sha256((body or "").encode("utf-8")).hexdigest()


def write_pair(body: str, root: Path) -> tuple[str, str, str]:
    day = date.today().isoformat()
    payload = body if body.endswith("\n") else body + "\n"
    digest = sha256_text(payload)
    inp_dir = root / "input"
    out_dir = root / "output"
    inp_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    src = inp_dir / f"{day}-會議.md"
    src.write_text(payload, encoding="utf-8", newline="\n")
    owners, dates, risks = harvest(body)
    card = (
        f"# 驗收卡 {day}\n"
        f"\n"
        f"- input: {src}\n"
        f"- sha256: {digest}\n"
        f"- owners: {'、'.join(owners) if owners else '未抽出'}\n"
        f"- dates: {'、'.join(dates) if dates else '未抽出'}\n"
        f"- risks: {risks}\n"
        f"\n"
        f"獨立驗收＝打開來源檔核對負責人／日期／風險，不是看「已完成」。\n"
        f"這張卡不代替行動清單正文。\n"
    )
    dest = out_dir / f"{day}-驗收卡.md"
    dest.write_text(card, encoding="utf-8", newline="\n")
    return str(src.resolve()), str(dest.resolve()), digest


def maybe_write(text: str, root: Path | None = None) -> tuple[str, str, str]:
    body = extract_body(text)
    if len(body) < MIN_BODY:
        return "", "", ""
    return write_pair(body, root or NEST_DEFAULT)


def format_brief(text: str, src: str = "", card: str = "", digest: str = "") -> str:
    body = extract_body(text)
    owners, dates, risks = harvest(body)
    must = []
    if owners:
        must.append("負責人=" + "、".join(owners))
    if dates:
        must.append("日期=" + "、".join(dates))
    if risks:
        must.append(f"風險={risks}處")
    lines = [
        "kind: accept-check",
        "shape: 材料｜動作｜限制｜驗收 四塊都要有，不准只喊整理",
        f"input: {src or '未給材料'}",
        f"input_hash: {digest or 'none'}",
        f"card_path: {card or '（未寫檔）'}",
        "limit: 不准改來源檔；不准掃練習目錄以外；不准把「已完成」當驗收",
        "fields: 事項、負責人、截止日期、風險提醒；不准壓成一句注意核對",
        f"must_keep: {'; '.join(must) if must else '材料太短，先貼會議正文'}",
        "layers: 回覆只是理解；這張卡只是指紋；人要打開來源檔對欄位",
        "sandbox: Discord 沒有 Pi 沙箱；真專案回桌上，不要對 holdings 練習",
        "install: 不准裝 Pi、不准把密鑰貼進對話",
        "vs_c15: C15 是有沒有交檔；本模式是交了以後用原檔核對",
        "vs_c17: C17 是建造流程；本模式是文件進出的獨立驗收",
        "vs_c14: C14 是附件轉 markdown；本模式是轉完後怎麼驗",
        "",
        "rule: never trust done; check the files.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    sample = (
        "獨立驗收 整理會議\n"
        "事項一 負責人：小林 截止日期 2026-09-01 風險：測試未凍結\n"
        "事項二 負責人：小周 截止日期 2026-09-03 風險：文案未定\n"
        "事項三 負責人：小陳 截止日期 2026-09-05 風險：權限未開\n"
    )
    assert is_accept(sample)
    assert is_accept("xiaomovps 不要信已完成")
    assert not is_accept("該不該買 NVDA")
    assert not is_accept("今天有什麼新庫")
    assert not is_accept("該建哪個機器人")
    owners, dates, risks = harvest(sample)
    assert owners == ["小林", "小周", "小陳"]
    assert "2026-09-01" in dates
    assert risks == 3
    tmp = Path(__file__).with_name("_tmp_accept")
    src, card, digest = maybe_write(sample, tmp)
    assert src and Path(src).exists()
    assert card and Path(card).exists()
    assert len(digest) == 64
    assert sha256_text(Path(src).read_text(encoding="utf-8")) == digest
    Path(src).unlink(missing_ok=True)
    Path(card).unlink(missing_ok=True)
    try:
        tmp.joinpath("input").rmdir()
        tmp.joinpath("output").rmdir()
        tmp.rmdir()
    except OSError:
        pass
    brief = format_brief("獨立驗收")
    assert "kind: accept-check" in brief
    assert "不准裝 Pi" in brief
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
    if not is_accept(blob):
        print("not_accept", file=sys.stderr)
        return 3
    src, card, digest = maybe_write(blob)
    print(format_brief(blob, src, card, digest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
