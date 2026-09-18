# -*- coding: utf-8 -*-
"""Short-video production spec (MoneyPrinterTurbo method, localized).

Topic → script → shot keywords → voice/captions → compose.
Discord oneshot writes a storyboard, does not emit MP4.
"""
from __future__ import annotations

import argparse
import html
import re
import sys
from datetime import date
from pathlib import Path

NEST_DEFAULT = Path(r"D:\ai-memory\research\athena_insights\html")

INTENT_RE = re.compile(
    r"(MoneyPrinterTurbo|短影片|短視頻|短视频|"
    r"一鍵.{0,6}(?:短)?影片|生成.{0,10}(?:短片|短影)|"
    r"主題.{0,16}(?:短)?影片|做一[條個支則].{0,8}(?:短影|Shorts)|"
    r"YouTube\s*Shorts|TikTok.{0,8}影片|豎屏影片|竖屏视频|"
    r"配音字幕合成)",
    re.I,
)
CONSUME_RE = re.compile(
    r"(影片筆記|這支講了什麼|这支讲了什么|字幕整理|逐字稿|Video transcript)",
    re.I,
)
SECRET_RE = re.compile(r"(中科院|機密|机密)")
LANDSCAPE_RE = re.compile(r"(橫屏|横屏|16\s*[:：]\s*9|landscape)", re.I)
EN_RE = re.compile(r"(英文|English|\ben\b)", re.I)
COMPOSE_RE = re.compile(r"(真的合成|交\s*mp4|ffmpeg|桌上合成)", re.I)
NOISE = re.compile(
    r"(幫我|帮我|做一[條個支則]|生成|短影片|短視頻|短视频|MoneyPrinterTurbo|"
    r"主題為|主题为|一鍵|配音字幕合成)",
    re.I,
)


def is_short_video(text: str) -> bool:
    blob = text or ""
    if CONSUME_RE.search(blob) and not INTENT_RE.search(blob):
        return False
    return bool(INTENT_RE.search(blob))


def parse_aspect(text: str) -> str:
    return "16:9" if LANDSCAPE_RE.search(text or "") else "9:16"


def parse_lang(text: str) -> str:
    return "en" if EN_RE.search(text or "") else "zh"


def parse_stop(text: str) -> str:
    return "compose" if COMPOSE_RE.search(text or "") else "spec"


def extract_subject(text: str) -> str:
    blob = NOISE.sub(" ", text or "")
    blob = re.sub(r"https?://\S+", " ", blob)
    blob = " ".join(blob.split()).strip(" ，,：:「」\"'")
    blob = re.sub(r"^(主題是|主题是|主題為|主题为)\s*", "", blob).strip(" ，,")
    return blob[:80] if blob else "未給主題"


def beats_from(text: str) -> list[str]:
    items = []
    for line in (text or "").splitlines():
        m = re.match(r"^(?:[-*]|[\d一二三四五六七八九十]+[、.．])\s*(.+)$", line.strip())
        if m:
            items.append(m.group(1).strip()[:60])
    return items[:6]


def slugify(title: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", title).strip("-")
    return (s[:40] or "short") 


def write_storyboard(subject: str, aspect: str, lang: str, beats: list[str], dest: Path) -> Path:
    t = html.escape(subject)
    if not beats:
        beats = ["開場一句話", "中段一個具體畫面", "收在一個動作"]
        note = "他沒分段，這三格只是骨架。用他的詞替換，不要編情節。"
    else:
        note = "理解準，畫面搜尋詞才貼題。Discord 停在分鏡，不是成片。"
    rows = []
    for i, b in enumerate(beats, 1):
        rows.append(
            f"<section class='shot'><p class='n'>鏡 {i}</p>"
            f"<p class='line'>{html.escape(b)}</p>"
            f"<p class='kw'>畫面搜尋詞：待填（從這句抽出名詞＋動作）</p></section>"
        )
    body = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title>
<style>
:root {{ --ink:#111; --line:#bbb; --bg:#f4f4f4; }}
* {{ box-sizing:border-box; }}
html,body {{ margin:0; background:var(--bg); color:var(--ink);
  font: 16px/1.4 system-ui,"Segoe UI",sans-serif; }}
main {{ max-width: 22rem; margin: 0 auto; padding: 1.2rem; }}
.meta {{ color:#555; font-size:.9rem; }}
.shot {{ border:1px solid var(--line); background:#fff; padding:.8rem; margin:.7rem 0; }}
.n {{ margin:0; font-size:.8rem; color:#666; }}
.line {{ margin:.3rem 0; font-weight:700; }}
.kw {{ margin:0; color:#555; font-size:.9rem; }}
h1 {{ font-size:1.15rem; }}
</style>
</head>
<body>
<main>
  <p class="meta">分鏡・{html.escape(aspect)}・{html.escape(lang)}・未合成</p>
  <h1>{t}</h1>
  {''.join(rows)}
  <p class="meta">{html.escape(note)}</p>
  <p class="meta">管線：主題 → 腳本 → 畫面關鍵詞 → 旁白／字幕 → 合成。本檔停在腳本＋關鍵詞。</p>
</main>
</body>
</html>
"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(body, encoding="utf-8", newline="\n")
    return dest


def maybe_write(text: str, root: Path | None = None) -> str:
    root = root or NEST_DEFAULT
    subject = extract_subject(text)
    name = f"{date.today().isoformat()}-short-{slugify(subject)}.html"
    path = write_storyboard(
        subject, parse_aspect(text), parse_lang(text), beats_from(text), root / name
    )
    return str(path.resolve())


def format_brief(text: str, artifact: str = "") -> str:
    subject = extract_subject(text)
    aspect = parse_aspect(text)
    lang = parse_lang(text)
    stop = parse_stop(text)
    secret = "yes" if SECRET_RE.search(text or "") else "no"
    lines = [
        "kind: short-video-spec",
        f"subject: {subject}",
        f"aspect: {aspect}",
        f"lang: {lang}",
        f"stop_at: {stop}",
        "pipe: 主題 → 腳本 → 畫面關鍵詞 → 旁白／字幕 → 合成",
        "match: 腳本理解準，畫面搜尋詞才貼題；不要先找片再硬套旁白",
        "voice: 預設中文旁白＋字幕；時間軸跟旁白走，不要假裝已 whisper",
        "batch: 最多兩個方向，讓他選一個；不要一次交十版",
        f"secret: {secret}",
        "cannot_render: discord-oneshot 不合成 MP4；禁止假裝已交成片",
        f"artifact_path: {artifact or '（未寫檔）'}",
        "publish: 不准自動上 TikTok／Shorts；對外發布要他自己說",
        "install: 不准裝 MoneyPrinterTurbo；桌上真要合成再走獨立工具",
        "keys: 不准把 API Key 寫進回覆",
        "",
        "rule: topic-to-storyboard; MP4 only if stop_at=compose on the desk.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_short_video("幫我做一個短影片，主題是城市早晨")
    assert is_short_video("MoneyPrinterTurbo 生成短片")
    assert not is_short_video("這支講了什麼")
    assert not is_short_video("該不該買 NVDA")
    assert parse_aspect("橫屏講深海") == "16:9"
    assert parse_aspect("做短影片") == "9:16"
    assert parse_stop("真的合成交 mp4") == "compose"
    assert extract_subject("幫我做一個短影片，主題是城市早晨") == "城市早晨"
    tmp = Path(sys.argv[0]).resolve().parent / "_tmp_short.html"
    p = maybe_write("幫我做一個短影片，主題是城市早晨", tmp.parent)
    assert Path(p).exists() and "short" in Path(p).name
    Path(p).unlink(missing_ok=True)
    brief = format_brief("做短影片 城市早晨")
    assert "stop_at: spec" in brief
    assert "cannot_render" in brief
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
    if not is_short_video(blob):
        print("not_short_video", file=sys.stderr)
        return 3
    artifact = maybe_write(blob)
    print(format_brief(blob, artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
