# -*- coding: utf-8 -*-
"""Capability-layer reach router (Agent-Reach method, localized).

Ordered backends, real path or none. Not a wrapper, not an install.
Does not scrape login-walled sites and does not call Agent-Reach CLI.
"""
from __future__ import annotations

import argparse
import re
import sys
from urllib.parse import urlparse

INTENT_RE = re.compile(
    r"(Agent-?Reach|這平台抓得到|抓得到嗎|有沒有零配置|"
    r"小紅書|小红书|xiaohongshu|雪球|"
    r"搜\s*reddit|reddit\s*上|reddit\.com|"
    r"幫我配\s*(Twitter|X|Reddit|小紅書|小红书|Facebook|Instagram|雪球|B站)|"
    r"這[個條].{0,8}(?:reddit|小紅書|小红书|臉書|脸书|\bIG\b|instagram))",
    re.I,
)
URL_RE = re.compile(r"https?://[^\s]+", re.I)

# Discord-oneshot backends we actually have. Login walls = none.
# backends: ordered preferred ▸ fallback (names only; agent calls them directly)
PLATFORMS = [
    ("x-status", ("x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com"), "xtf ▸ none", "xtf", "no", ""),
    ("youtube", ("youtube.com", "youtu.be"), "video_caption_fetch ▸ none", "video_caption_fetch", "no", ""),
    ("bilibili", ("bilibili.com", "b23.tv"), "video_caption_fetch ▸ none", "video_caption_fetch", "no", ""),
    ("arxiv", ("arxiv.org", "export.arxiv.org"), "arxiv_fetch ▸ none", "arxiv_fetch", "no", ""),
    ("reddit", ("reddit.com", "old.reddit.com"), "none", "none", "yes", "kuilei-shu／browse"),
    ("xiaohongshu", ("xiaohongshu.com", "xhslink.com"), "none", "none", "yes", "kuilei-shu／browse；專用小號"),
    ("facebook", ("facebook.com", "fb.com"), "none", "none", "yes", "kuilei-shu／browse"),
    ("instagram", ("instagram.com",), "none", "none", "yes", "kuilei-shu／browse"),
    ("xueqiu", ("xueqiu.com",), "none", "none", "yes", "桌上查；不要用主帳"),
    ("linkedin", ("linkedin.com",), "jina-public ▸ none", "jina", "partial", "公開頁可試；詳情要登入"),
    ("github", ("github.com",), "jina ▸ gh", "jina", "no", ""),
    ("web", (), "jina ▸ news_score", "jina", "no", ""),
]

GATED = {"reddit", "xiaohongshu", "facebook", "instagram", "xueqiu"}
KW = [
    ("xiaohongshu", r"小紅書|小红书|xiaohongshu|xhs"),
    ("reddit", r"reddit"),
    ("facebook", r"facebook|臉書|脸书"),
    ("instagram", r"instagram|\bIG\b"),
    ("xueqiu", r"雪球|xueqiu"),
    ("youtube", r"youtube"),
    ("bilibili", r"b站|bilibili"),
    ("linkedin", r"linkedin|領英|领英"),
    ("github", r"github"),
]


def host_of(url: str) -> str:
    try:
        host = urlparse(url.strip().rstrip(").,]>\"'")).hostname or ""
    except Exception:
        return ""
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def is_x_status(url: str) -> bool:
    return bool(re.search(r"/status/\d+", url or "", re.I))


def classify(text: str) -> str:
    blob = text or ""
    for raw in URL_RE.findall(blob):
        host = host_of(raw)
        if not host:
            continue
        if host in {"x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com"}:
            return "x-status" if is_x_status(raw) else "x-other"
        for name, hosts, _b, _a, _l, _d in PLATFORMS:
            if name in {"web", "x-status"}:
                continue
            if any(host == h or host.endswith("." + h) for h in hosts):
                return name
    for name, pat in KW:
        if re.search(pat, blob, re.I):
            return name
    return "web"


def row_for(name: str) -> tuple[str, str, str, str, str]:
    if name == "x-other":
        return "x_search_brief ▸ grok x_search ▸ none", "x_search", "no", "這不是單帖；不要拿 Jina 硬抓時間線"
    for n, _h, backends, active, login, desk in PLATFORMS:
        if n == name:
            return backends, active, login, desk
    return "jina ▸ news_score", "jina", "no", ""


def is_reach(text: str) -> bool:
    blob = text or ""
    if INTENT_RE.search(blob):
        return True
    name = classify(blob)
    return name in GATED or name == "x-other"


def format_brief(text: str) -> str:
    name = classify(text)
    backends, active, login, desk = row_for(name)
    gated = "yes" if name in GATED or (name == "x-other" and active != "xtf") else "no"
    if name in GATED:
        gated = "yes"
    lines = [
        "kind: capability-layer",
        f"platform: {name}",
        f"backends: {backends}",
        f"active: {active}",
        f"login: {login}",
        f"gated: {gated}",
        f"desk: {desk or '無'}",
        "probe: 只承認腳本真的抓到的東西；裝了但壞了＝沒抓到",
        "wrap: 不是包裝層；不要另裝 Agent-Reach／OpenCLI",
        "cookie: 不讀瀏覽器 Cookie、不用主帳、不把登入牆當正文",
        "fail: active=none 就說抓不到，禁止用 Jina 垃圾摘要充數",
        "",
        "rule: ordered backends; first working wins; no zero-config = say so.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_reach("這平台抓得到嗎 reddit")
    assert is_reach("https://www.reddit.com/r/python/comments/abc")
    assert is_reach("小紅書這個品口碑")
    assert is_reach("https://www.xiaohongshu.com/explore/1")
    assert not is_reach("該不該買 NVDA")
    assert not is_reach("今天有什麼新庫")
    assert classify("https://www.reddit.com/r/x") == "reddit"
    assert classify("https://x.com/a/status/123") == "x-status"
    assert classify("https://x.com/elonmusk") == "x-other"
    assert classify("幫我看看小紅書口碑") == "xiaohongshu"
    brief = format_brief("https://www.reddit.com/r/ai")
    assert "platform: reddit" in brief
    assert "active: none" in brief
    assert "login: yes" in brief
    yt = format_brief("https://www.youtube.com/watch?v=abc")
    assert "active: video_caption_fetch" in yt
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
    if not is_reach(blob):
        print("not_reach", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
