# -*- coding: utf-8 -*-
"""Fetch one X/Twitter status URL for AthenaBot. UTF-8 text on stdout."""
from __future__ import annotations

import argparse
import re
import sys
from urllib.parse import urlparse

from xtf import Router
from xtf.exceptions import XtfError

MAX_CHARS = 20000
_SENT_SPLIT = re.compile(r"(?<=[。！？.!?])\s+")
HOSTS = {
    "x.com",
    "twitter.com",
    "fxtwitter.com",
    "vxtwitter.com",
    "fixupx.com",
    "fixvx.com",
}


def parse_status(url: str) -> tuple[str, str] | None:
    raw = url.strip().rstrip(").,]>\"'")
    parsed = urlparse(raw)
    host = (parsed.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host not in HOSTS:
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if "status" not in parts:
        return None
    i = parts.index("status")
    if i < 1 or i + 1 >= len(parts):
        return None
    user = parts[i - 1]
    tid = re.sub(r"\D.*$", "", parts[i + 1])
    if not user or not tid:
        return None
    return user, tid


def lead3(text: str) -> str:
    """Extractive lead-3 baseline (Hugging Face course ch7.5)."""
    cleaned = " ".join((text or "").split())
    if not cleaned:
        return ""
    parts = [p.strip() for p in _SENT_SPLIT.split(cleaned) if p.strip()]
    if not parts:
        return cleaned[:300]
    return "\n".join(parts[:3])


def format_tweet(data: dict) -> str:
    lines = [
        f"Author: {data.get('author', '')} (@{data.get('screen_name', '')})",
        f"Time: {data.get('created_at', '')}",
        (
            f"Stats: likes={data.get('likes', 0)} "
            f"rts={data.get('retweets', 0)} views={data.get('views', 0)}"
        ),
        "",
        str(data.get("text") or ""),
    ]
    art = data.get("article") or {}
    if art.get("title") or art.get("full_text") or art.get("preview_text"):
        lines += [
            "",
            f"Article: {art.get('title', '')}",
            str(art.get("full_text") or art.get("preview_text") or ""),
        ]
    quoted = data.get("quote")
    if quoted:
        lines += [
            "",
            f"Quoted @{quoted.get('screen_name', '')}:",
            str(quoted.get("text") or ""),
        ]
    body = str(
        (data.get("article") or {}).get("full_text")
        or (data.get("article") or {}).get("preview_text")
        or data.get("text")
        or ""
    )
    baseline = lead3(body)
    if baseline:
        lines += ["", "--- Lead-3 baseline ---", baseline]
    text = "\n".join(lines).strip()
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + "\n...[truncated]"
    return text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    args = parser.parse_args()
    parsed = parse_status(args.url)
    if parsed is None:
        print("not a status URL", file=sys.stderr)
        return 2
    user, tid = parsed
    try:
        data = Router().fetch_tweet(user, tid)
    except XtfError as e:
        print(str(e), file=sys.stderr)
        return 1
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(format_tweet(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
