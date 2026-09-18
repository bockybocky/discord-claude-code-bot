# -*- coding: utf-8 -*-
"""Compile an X advanced-search query from a Discord ask.

Method from @_HIT_SZ_ 2026-08-24: five questions, wide-to-narrow,
until: is exclusive, from: is handle without @.
Does not reverse-image-search screenshots.
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date, timedelta

HANDLE_RE = re.compile(r"(?:from:|to:|@)([A-Za-z0-9_]{1,15})")
ISO_RE = re.compile(r"\b(20\d{2})-(\d{1,2})-(\d{1,2})\b")
MD_RE = re.compile(r"(\d{1,2})[月/.\-](\d{1,2})日?")
FAVES_RE = re.compile(r"(?:至少|超過|>=)?\s*(\d+)\s*(?:讚|赞|likes?|faves?)", re.I)
SEARCH_RE = re.compile(
    r"(搜\s*X|搜推特|搜\s*twitter|找推文|找回原帖|誰發過|谁发过|"
    r"這個帳號發|这个账号发|進階搜尋|高级搜索|from:|高讚帖|高赞帖|"
    r"X 上找|X上找|twitter 搜|找某人發|書籤找不到|某一天的帖|"
    r"回覆給\s*@|回复给\s*@|(?:找|搜).{0,24}(?:帖|推文|twitter))",
    re.I,
)
NOISE = {
    "幫我", "帮我", "找", "搜", "一下", "的", "了", "嗎", "么", "請", "请",
    "推文", "原帖", "帖子", "twitter", "x", "帳號", "账号", "發過", "发过",
    "截圖", "截图", "只有", "一張", "一张", "想找", "什麼", "什么",
}

PEEL = "exclude → heat → media → lang → date → account → phrase"


def is_search_intent(text: str) -> bool:
    blob = text or ""
    if SEARCH_RE.search(blob):
        return True
    if HANDLE_RE.search(blob) and any(
        k in blob for k in ("找", "搜", "發過", "发过", "發了", "发了", "帖", "講", "讲")
    ):
        return True
    return False


def parse_handle(text: str, kind: str) -> str:
    if kind == "from":
        m = re.search(r"from:([A-Za-z0-9_]{1,15})", text or "", re.I)
        if m:
            return m.group(1)
        m = re.search(r"(?:帳號|账号|這個帳號|这个账号)\s*@?([A-Za-z0-9_]{1,15})", text or "")
        if m:
            return m.group(1)
    if kind == "to":
        m = re.search(r"to:([A-Za-z0-9_]{1,15})", text or "", re.I)
        if m:
            return m.group(1)
        m = re.search(r"(?:回覆給|回复给)\s*@?([A-Za-z0-9_]{1,15})", text or "")
        if m:
            return m.group(1)
    m = re.search(r"@([A-Za-z0-9_]{1,15})", text or "")
    if m and kind == "from" and not re.search(r"回覆給|回复给|to:", text or ""):
        return m.group(1)
    return ""


def parse_day(text: str, today: date) -> tuple[str, str]:
    blob = text or ""
    if "今年" in blob:
        return f"{today.year}-01-01", f"{today.year + 1}-01-01"
    if "昨天" in blob:
        d = today - timedelta(days=1)
        nxt = d + timedelta(days=1)
        return d.isoformat(), nxt.isoformat()
    if "今天" in blob or "今日" in blob:
        nxt = today + timedelta(days=1)
        return today.isoformat(), nxt.isoformat()
    m = ISO_RE.search(blob)
    if m:
        d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        return d.isoformat(), (d + timedelta(days=1)).isoformat()
    m = MD_RE.search(blob)
    if m:
        d = date(today.year, int(m.group(1)), int(m.group(2)))
        return d.isoformat(), (d + timedelta(days=1)).isoformat()
    return "", ""


def keywords(text: str) -> list[str]:
    blob = text or ""
    blob = HANDLE_RE.sub(" ", blob)
    blob = ISO_RE.sub(" ", blob)
    blob = MD_RE.sub(" ", blob)
    blob = re.sub(
        r"找回原帖|找推文|搜推特|進階搜尋|高级搜索|書籤找不到|高讚帖|高赞帖|某一天的帖",
        " ",
        blob,
    )
    blob = re.sub(r"截圖|截图|https?://\S+", " ", blob)
    blob = re.sub(r"今年|昨天|今天|今日|不要回覆|不要回复|的原帖|原帖", " ", blob)
    blob = re.sub(r"發了什麼|发了什么|講了什麼|讲了什么|發了啥", " ", blob)
    blob = re.sub(r"[「」『』]", " ", blob)
    parts = []
    for tok in re.split(r"\s+", blob):
        t = tok.strip("，。！？、,.!?")
        if len(t) < 2 or t.lower() in NOISE:
            continue
        if re.fullmatch(r"[\W_]+", t):
            continue
        if t in {"不要回覆", "不要回复", "原帖", "截圖", "截图"}:
            continue
        if re.fullmatch(r"(只有|一張|一张|想要|那個|那个)+", t):
            continue
        parts.append(t)
    return parts[:8]


def compile_query(text: str, today: date | None = None) -> dict:
    today = today or date.today()
    blob = text or ""
    frm = parse_handle(blob, "from")
    to = parse_handle(blob, "to")
    since, until = parse_day(blob, today)
    kws = keywords(blob)
    faves = FAVES_RE.search(blob)
    min_faves = faves.group(1) if faves else ("100" if re.search(r"高讚|高赞", blob) else "")
    want_images = bool(re.search(r"帶圖|带图|圖片帖|图片帖|filter:images", blob))
    want_media = bool(re.search(r"帶媒體|带媒体|filter:media", blob))
    want_links = bool(re.search(r"外連|外链|教程|教學|教学|filter:links", blob))
    no_replies = bool(re.search(r"不要回覆|不要回复|-filter:replies", blob)) or bool(frm and not to)
    english = bool(re.search(r"英文|lang:en", blob))
    screenshot = bool(re.search(r"截圖|截图|找回原帖", blob))
    mention = ""
    if re.search(r"提及|提到|外部.*帳號|外部.*账号", blob) and frm:
        mention = frm
        frm = ""

    layers = []
    q = []
    if kws:
        if len(kws) == 1:
            q.append(kws[0] if " " not in kws[0] else f'"{kws[0]}"')
        else:
            q.append(" ".join(kws))
        layers.append("keywords")
    if frm:
        q.append(f"from:{frm.lstrip('@')}")
        layers.append("account")
    if to:
        q.append(f"to:{to.lstrip('@')}")
        layers.append("account")
    if mention:
        h = mention.lstrip("@")
        q.append(f"@{h} -from:{h}")
        layers.append("account")
    if since:
        q.append(f"since:{since}")
        q.append(f"until:{until}")
        layers.append("date")
    if english:
        q.append("lang:en")
        layers.append("lang")
    if want_images:
        q.append("filter:images")
        layers.append("media")
    elif want_media:
        q.append("filter:media")
        layers.append("media")
    if want_links:
        q.append("filter:links")
        layers.append("media")
    if min_faves:
        q.append(f"min_faves:{min_faves}")
        layers.append("heat")
    if no_replies:
        q.append("-filter:replies")
        layers.append("exclude")

    query = " ".join(q).strip()
    sort = "Latest" if since or re.search(r"時間|时间|某一天|當天|当天", blob) else "Top"
    cannot = []
    if screenshot and not kws and not frm:
        cannot.append("filter:images 不是以圖搜圖，也不讀圖裡的字；截圖 alone 找不到原帖")
    if not query:
        cannot.append("條件不足：至少要關鍵詞或 handle")
    return {
        "query": query,
        "sort": sort,
        "layers": layers,
        "from": frm,
        "since": since,
        "until": until,
        "cannot": cannot,
        "screenshot": screenshot,
    }


def format_brief(text: str, today: date | None = None) -> str:
    info = compile_query(text, today)
    lines = [
        f"query: {info['query'] or '(empty)'}",
        f"sort: {info['sort']}",
        f"layers: {' > '.join(info['layers']) or '(none)'}",
        f"peel_if_empty: {PEEL}",
        "until_rule: until: 不含當日；要含 8/24 就寫 until:次日",
        "from_rule: from:/to: 寫 handle，不寫顯示名，不帶 @",
        "images_rule: filter:images 只留帶圖帖，不是以圖搜圖",
        "lang_rule: 中英混寫不要硬加 lang:；中文用中文關鍵詞",
        "heat_rule: min_faves 只是門檻，不是正確或權威",
        "wide_to_narrow: 一次只加一層；結果變零就反向拆一層",
    ]
    for c in info["cannot"]:
        lines.append(f"cannot: {c}")
    lines.extend(
        [
            "",
            "rule: run x_search with this query. Show the query. If empty, peel one layer.",
            "Do not invent handles. Do not claim a screenshot found the original post.",
        ]
    )
    return "\n".join(lines)


def run_selftest() -> int:
    today = date(2026, 8, 26)
    q1 = compile_query("找 @_HIT_SZ_ 今年講 gpt 的原帖不要回覆", today)
    assert "from:_HIT_SZ_" in q1["query"], q1
    assert "since:2026-01-01" in q1["query"]
    assert "until:2027-01-01" in q1["query"]
    assert "-filter:replies" in q1["query"]
    q2 = compile_query("8月24日 @_HIT_SZ_ 發了什麼", today)
    assert "since:2026-08-24" in q2["query"]
    assert "until:2026-08-25" in q2["query"], q2
    q3 = compile_query("只有一張截圖想找回原帖", today)
    assert q3["cannot"]
    q4 = compile_query("英文 AI coding 高讚圖片帖", today)
    assert "filter:images" in q4["query"]
    assert "min_faves:100" in q4["query"]
    assert "lang:en" in q4["query"]
    assert is_search_intent("幫我找 OpenAI 發過 GPT-5 的帖")
    assert is_search_intent("8月24日 @_HIT_SZ_ 發了什麼")
    assert not is_search_intent("https://x.com/a/status/1 幫我摘要")
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
    if not is_search_intent(blob):
        print("not_x_search", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
