# -*- coding: utf-8 -*-
"""Deterministic news evidence gate (news-getter scoring.py)."""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

THRESHOLD = 60
WINDOW_SEC = 15 * 3600
STORE = Path(__file__).resolve().parents[1] / "athena-curator" / "news_seen.json"

# 1=一手官方 2=專業媒體 3=專家 4=聚合/社群/未知
TIER1 = {
    "sec.gov",
    "federalreserve.gov",
    "bls.gov",
    "openai.com",
    "huggingface.co",
}
TIER2 = {
    "reuters.com",
    "bloomberg.com",
    "wsj.com",
    "ft.com",
    "economist.com",
    "bbc.com",
    "bbc.co.uk",
    "apnews.com",
    "nikkei.com",
    "nature.com",
    "science.org",
    "digitimes.com",
    "digitimes.com.tw",
    "ithome.com.tw",
    "technews.tw",
    "ltn.com.tw",
    "cna.com.tw",
    "cnbc.com",
    "nytimes.com",
}
TIER3 = {
    "seekingalpha.com",
    "substack.com",
    "semianalysis.com",
    "stratechery.com",
}
TIER4 = {
    "news.google.com",
    "yahoo.com",
    "finance.yahoo.com",
    "marketwatch.com",
    "reddit.com",
    "medium.com",
    "twitter.com",
    "x.com",
}


def host_of(url: str) -> str:
    host = urlparse(url.strip()).netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def tier_of(host: str) -> int:
    if host in TIER1 or host.endswith(".gov"):
        return 1
    if host in TIER2:
        return 2
    if any(host.endswith("." + h) or host == h for h in TIER2):
        return 2
    if host in TIER3 or host.endswith(".substack.com"):
        return 3
    if host in TIER4:
        return 4
    return 4


def clamp(v: float) -> int:
    return max(0, min(100, round(v)))


def score_story(tiers: list[int], seen_count: int, distinct_sources: int) -> dict:
    authority = 100 - (min(tiers) - 1) * 25
    confidence = clamp(authority * 0.7 + min(distinct_sources, 4) * 7.5)
    heat = clamp(min(seen_count, 6) * 12 + min(distinct_sources, 4) * 10)
    return {"confidence": confidence, "heat": heat, "authority": authority}


def fingerprint(url: str) -> str:
    p = urlparse(url.strip())
    path = re.sub(r"/+$", "", p.path)
    return f"{host_of(url)}{path}".lower()


def load_store() -> dict:
    if not STORE.exists():
        return {}
    try:
        return json.loads(STORE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_store(data: dict) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - WINDOW_SEC
    pruned = {k: v for k, v in data.items() if float(v.get("ts", 0)) >= cutoff}
    STORE.write_text(json.dumps(pruned, ensure_ascii=False, indent=2), encoding="utf-8")


def bump(urls: list[str]) -> tuple[int, int, list[int], list[str]]:
    now = time.time()
    store = load_store()
    hosts: list[str] = []
    tiers: list[int] = []
    seen = 1
    for url in urls:
        h = host_of(url)
        if not h:
            continue
        hosts.append(h)
        tiers.append(tier_of(h))
        fp = fingerprint(url)
        row = store.get(fp) or {"ts": now, "count": 0, "hosts": []}
        if now - float(row.get("ts", now)) > WINDOW_SEC:
            row = {"ts": now, "count": 0, "hosts": []}
        row["count"] = int(row.get("count", 0)) + 1
        row["ts"] = now
        hs = set(row.get("hosts") or [])
        hs.add(h)
        row["hosts"] = sorted(hs)
        store[fp] = row
        seen = max(seen, row["count"])
    save_store(store)
    distinct = len(set(hosts)) or 1
    if not tiers:
        tiers = [4]
    return seen, distinct, tiers, sorted(set(hosts))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("--also", nargs="*", default=[])
    args = p.parse_args()
    urls = [args.url, *args.also]
    seen, distinct, tiers, hosts = bump(urls)
    scores = score_story(tiers, seen, distinct)
    gate = "DEEP" if scores["confidence"] >= THRESHOLD or scores["heat"] >= THRESHOLD else "WATCH"
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(f"gate: {gate}")
    print(f"confidence: {scores['confidence']}")
    print(f"heat: {scores['heat']}")
    print(f"authority: {scores['authority']}")
    print(f"tier: {min(tiers)}")
    print(f"seen_count: {seen}")
    print(f"distinct_sources: {distinct}")
    print(f"hosts: {', '.join(hosts)}")
    print("rule: DEEP only if confidence>=60 or heat>=60; else 觀察中, no fake deep analysis.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
