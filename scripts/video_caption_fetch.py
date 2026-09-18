# -*- coding: utf-8 -*-
"""Fetch timed captions for YouTube/Bilibili. Captions first, no guessed timestamps."""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MAX_CHARS = 18_000
YT_HOSTS = {"youtube.com", "youtu.be", "m.youtube.com", "www.youtube.com"}
BILI_HOSTS = {"bilibili.com", "www.bilibili.com", "b23.tv", "m.bilibili.com"}
LANGS = ("zh-TW", "zh-Hant", "zh-CN", "zh", "en")


def fmt_ts(seconds: float) -> str:
    total = max(0, int(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def youtube_id(url: str) -> str | None:
    p = urlparse(url.strip().rstrip(").,]>\"'"))
    host = (p.netloc or "").lower().removeprefix("www.")
    if host == "youtu.be":
        vid = p.path.strip("/").split("/")[0]
        return vid or None
    if "youtube.com" in host:
        qs = parse_qs(p.query)
        if qs.get("v"):
            return qs["v"][0]
        parts = [x for x in p.path.split("/") if x]
        if parts and parts[0] in {"shorts", "live", "embed"} and len(parts) > 1:
            return parts[1]
    return None


def is_bili(url: str) -> bool:
    host = urlparse(url.strip()).netloc.lower().removeprefix("www.")
    return host in BILI_HOSTS or "bilibili.com" in host or host == "b23.tv"


def fetch_youtube(url: str) -> tuple[list[tuple[float, float, str]], str]:
    vid = youtube_id(url)
    if not vid:
        raise ValueError("not a YouTube video URL")
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    fetched = api.fetch(vid, languages=list(LANGS))
    segs: list[tuple[float, float, str]] = []
    for item in fetched:
        start = float(getattr(item, "start", 0) if not isinstance(item, dict) else item.get("start", 0))
        dur = float(getattr(item, "duration", 0) if not isinstance(item, dict) else item.get("duration", 0))
        text = str(getattr(item, "text", "") if not isinstance(item, dict) else item.get("text", ""))
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            segs.append((start, start + dur, text))
    lang = getattr(fetched, "language_code", "") or "captions"
    return segs, f"youtube-captions:{lang}"


def fetch_ytdlp(url: str) -> tuple[list[tuple[float, float, str]], str]:
    import subprocess

    tmp = Path(tempfile.mkdtemp(prefix="athena-vtt-"))
    try:
        cmd = [
            "yt-dlp",
            "--skip-download",
            "--write-sub",
            "--write-auto-sub",
            "--sub-langs",
            "zh-TW,zh-Hant,zh,en.*",
            "--sub-format",
            "vtt",
            "--no-playlist",
            "-o",
            str(tmp / "clip"),
            url,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        vtts = sorted(tmp.glob("*.vtt"))
        if not vtts:
            err = (proc.stderr or proc.stdout or "no vtt").strip().splitlines()[-1:]
            raise RuntimeError(err[0] if err else "no captions")
        segs = parse_vtt(vtts[0].read_text(encoding="utf-8-sig", errors="replace"))
        return segs, f"yt-dlp:{vtts[0].name}"
    finally:
        for p in tmp.glob("*"):
            try:
                p.unlink()
            except OSError:
                pass
        try:
            tmp.rmdir()
        except OSError:
            pass


_VTT_TIME = re.compile(
    r"(?P<start>\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*"
    r"(?P<end>\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})"
)


def _ts(value: str) -> float:
    parts = value.replace(",", ".").split(":")
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])


def parse_vtt(payload: str) -> list[tuple[float, float, str]]:
    lines = payload.replace("\r\n", "\n").split("\n")
    segs: list[tuple[float, float, str]] = []
    i = 0
    while i < len(lines):
        m = _VTT_TIME.search(lines[i])
        if not m:
            i += 1
            continue
        start, end = _ts(m.group("start")), _ts(m.group("end"))
        i += 1
        text_lines: list[str] = []
        while i < len(lines) and lines[i].strip():
            cleaned = re.sub(r"<[^>]+>", "", lines[i]).strip()
            if cleaned and not cleaned.startswith("NOTE"):
                text_lines.append(cleaned)
            i += 1
        text = re.sub(r"\s+", " ", " ".join(text_lines)).strip()
        if text:
            segs.append((start, end, text))
    return segs


def format_out(url: str, segs: list[tuple[float, float, str]], source: str) -> str:
    if not segs:
        raise RuntimeError("empty captions")
    body_lines = [f"[{fmt_ts(a)}-{fmt_ts(b)}] {t}" for a, b, t in segs]
    body = "\n".join(body_lines)
    if len(body) > MAX_CHARS:
        body = body[:MAX_CHARS] + "\n...[truncated]"
    return (
        f"source: {source}\n"
        f"url: {url}\n"
        f"segments: {len(segs)}\n"
        "rule: timestamps below are from captions; do not invent new times.\n"
        f"{body}"
    )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("url")
    args = p.parse_args()
    url = args.url.strip().rstrip(").,]>\"'")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        if youtube_id(url):
            try:
                segs, src = fetch_youtube(url)
            except Exception as e:
                print(f"youtube api failed: {e}", file=sys.stderr)
                segs, src = fetch_ytdlp(url)
        elif is_bili(url):
            segs, src = fetch_ytdlp(url)
        else:
            print("not a video URL", file=sys.stderr)
            return 2
        print(format_out(url, segs, src))
        return 0
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
