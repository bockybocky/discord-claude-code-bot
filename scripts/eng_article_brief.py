# -*- coding: utf-8 -*-
"""First-hand scale engineering-article brief.

Method from ashishps1/awesome-engineering-articles:
company axis + topic tags + year; original company blog; not marketing.
Does not clone the 300-article list.
"""
from __future__ import annotations

import argparse
import re
import sys
from urllib.parse import urlparse

# Canonical blogs only (homes), not the article dump.
COMPANIES = [
    ("Airbnb", ("airbnb", "愛彼迎"), ("airbnb-engineering",), "https://medium.com/airbnb-engineering"),
    ("Amazon", ("amazon science", "amazon.science"), ("amazon.science",), "https://www.amazon.science/blog"),
    ("Atlassian", ("atlassian",), ("atlassian.com/blog",), "https://www.atlassian.com/blog/developer"),
    ("Booking.com", ("booking.com", "booking"), ("blog.booking.com", "booking-com-development"), "https://blog.booking.com/"),
    ("Canva", ("canva",), ("canva.dev",), "https://www.canva.dev/blog/engineering/"),
    ("Coinbase", ("coinbase",), ("coinbase.com/blog",), "https://www.coinbase.com/blog/landing/engineering"),
    ("Discord", ("discord",), ("discord.com/blog", "blog.discord.com"), "https://blog.discord.com/"),
    ("DoorDash", ("doordash",), ("careersatdoordash.com",), "https://careersatdoordash.com/engineering-blog/"),
    ("Dropbox", ("dropbox",), ("dropbox.tech",), "https://dropbox.tech/"),
    ("eBay", ("ebay",), ("innovation.ebayinc.com",), "https://innovation.ebayinc.com/tech/"),
    ("Meta", ("facebook", "meta", "臉書"), ("engineering.fb.com",), "https://engineering.fb.com/"),
    ("Figma", ("figma",), ("figma.com/blog",), "https://www.figma.com/blog/engineering/"),
    ("Flipkart", ("flipkart",), ("blog.flipkart.tech",), "https://blog.flipkart.tech/"),
    ("GitHub", ("github",), ("github.blog/engineering",), "https://github.blog/engineering/"),
    ("Google", ("google research", "google"), ("research.google",), "https://research.google/blog/"),
    ("Instagram", ("instagram", "ig"), ("engineering.fb.com/tag/instagram",), "https://engineering.fb.com/tag/instagram/"),
    ("Instacart", ("instacart",), ("tech.instacart.com",), "https://tech.instacart.com/"),
    ("LinkedIn", ("linkedin",), ("linkedin.com/blog/engineering", "engineering.linkedin"), "https://www.linkedin.com/blog/engineering"),
    ("Lyft", ("lyft",), ("eng.lyft.com",), "https://eng.lyft.com/"),
    ("Netflix", ("netflix", "網飛"), ("netflixtechblog.com",), "https://netflixtechblog.com/"),
    ("Notion", ("notion",), ("notion.com/blog",), "https://www.notion.com/blog"),
    ("PayPal", ("paypal",), ("paypal-tech",), "https://medium.com/paypal-tech"),
    ("Pinterest", ("pinterest",), ("pinterest-engineering",), "https://medium.com/pinterest-engineering"),
    ("Quora", ("quora",), ("engineering.quora.com", "quoraengineering"), "https://engineering.quora.com/"),
    ("Razorpay", ("razorpay",), ("engineering.razorpay.com",), "https://engineering.razorpay.com/"),
    ("Reddit", ("reddit",), ("reddit.com/r/redditeng",), "https://www.reddit.com/r/RedditEng/"),
    ("Salesforce", ("salesforce",), ("engineering.salesforce.com",), "https://engineering.salesforce.com/"),
    ("Shopify", ("shopify",), ("shopify.engineering",), "https://shopify.engineering/"),
    ("Slack", ("slack",), ("slack.engineering",), "https://slack.engineering/"),
    ("Snap", ("snapchat", "snap"), ("eng.snap.com",), "https://eng.snap.com/blog"),
    ("Spotify", ("spotify",), ("engineering.atspotify.com",), "https://engineering.atspotify.com/"),
    ("Stripe", ("stripe",), ("stripe.com/blog",), "https://stripe.com/blog/engineering"),
    ("Swiggy", ("swiggy",), ("bytes.swiggy.com",), "https://bytes.swiggy.com/"),
    ("Tinder", ("tinder",), ("medium.com/tinder",), "https://medium.com/tinder"),
    ("Twitch", ("twitch",), ("blog.twitch.tv",), "https://blog.twitch.tv/en/tags/engineering/"),
    ("X", ("twitter", "twitter/x"), ("blog.x.com", "blog.twitter.com"), "https://blog.x.com/engineering"),
    ("Uber", ("uber", "優步"), ("eng.uber.com", "uber.com/blog", "uber.com/en-"), "https://eng.uber.com/"),
    ("Walmart", ("walmart",), ("walmartglobaltech",), "https://medium.com/walmartglobaltech"),
    ("Zomato", ("zomato",), ("blog.zomato.com",), "https://blog.zomato.com/category/technology"),
]

TOPICS = [
    ("Search", r"搜尋|检索|search|檢索|ranking|lucene|autocomplete"),
    ("AI/ML", r"推薦|recommend|llm|機器學習|机器学习|genai|embedding|ml\b|ai/ml"),
    ("Performance", r"效能|性能|延遲|延迟|latency|performance|吞吐|throughput"),
    ("Frontend", r"前端|frontend|頁面|页面|wasm"),
    ("Data Engineering", r"資料平台|数据平台|data lake|kafka|flink|串流|cdc"),
    ("Payments", r"支付|payments?|ledger|double.?pay"),
    ("Architecture", r"架構|架构|architecture|微服務|微服务|monolith"),
    ("Security", r"資安|安全|fraud|security"),
    ("Databases", r"資料庫|数据库|postgres|mysql|cassandra|shard|分片|vitess"),
    ("Infrastructure", r"基礎設施|基础设施|k8s|kubernetes|infra"),
    ("Cost Optimization", r"成本|cloud cost|省錢|省钱"),
    ("Observability", r"觀測|观测|logging|tracing|observab"),
    ("Caching", r"快取|缓存|cache"),
    ("Messaging", r"訊息|消息|websocket|notification|推播|推送"),
    ("Video/Media", r"影音|video|streaming|轉碼|转码"),
    ("Mobile", r"手機|手机|ios|android|mobile"),
]

INTENT_RE = re.compile(
    r"(工程文|工程部落格|工程博客|engineering\s+blog|engineering\s+articles?|"
    r"awesome-engineering|一手尺度|公司工程|"
    r"怎麼\s*scale|怎么\s*scale|如何\s*scale|大規模.{0,10}(?:工程|系統|系统)|"
    r"(?:怎麼|怎么|如何).{0,16}(?:擴展|扩展|分片|搜尋系統|搜索系统|快取|缓存))",
    re.I,
)
COMPANY_HOW_RE = re.compile(
    r"(airbnb|amazon|atlassian|booking|canva|coinbase|discord|doordash|"
    r"dropbox|ebay|facebook|meta|figma|flipkart|github|google|instagram|"
    r"instacart|linkedin|lyft|netflix|網飛|notion|paypal|pinterest|quora|"
    r"razorpay|reddit|salesforce|shopify|slack|snapchat|\bsnap\b|spotify|"
    r"stripe|swiggy|tinder|twitch|twitter|\buber\b|優步|walmart|zomato)"
    r".{0,20}(?:怎麼|怎么|工程|scale|擴展|扩展|搜尋|搜索|快取|缓存|分片)",
    re.I,
)
LISTICLE_RE = re.compile(
    r"(top\s*\d+|十大|百大|最佳.{0,8}部落格|最佳.{0,8}博客|"
    r"工程部落格清單|engineering blogs?\s+list)",
    re.I,
)
YEAR_RE = re.compile(r"\b(20(?:1\d|2[0-6]))\b")
URL_RE = re.compile(r"https?://[^\s]+", re.I)

# Distinctive host/path fragments for first-hand company blogs.
BLOG_NEEDLE_RE = re.compile(
    r"(netflixtechblog|eng\.uber\.com|engineering\.fb\.com|shopify\.engineering|"
    r"slack\.engineering|dropbox\.tech|canva\.dev|eng\.lyft\.com|eng\.snap\.com|"
    r"engineering\.atspotify\.com|linkedin\.com/blog/engineering|tech\.instacart|"
    r"careersatdoordash|innovation\.ebayinc|blog\.flipkart|engineering\.razorpay|"
    r"engineering\.salesforce|bytes\.swiggy|blog\.zomato|amazon\.science|"
    r"research\.google|github\.blog/engineering|figma\.com/blog|notion\.com/blog|"
    r"stripe\.com/blog|blog\.discord|discord\.com/blog|airbnb-engineering|"
    r"booking-com-development|paypal-tech|pinterest-engineering|walmartglobaltech|"
    r"redditeng|blog\.x\.com|blog\.twitter\.com|medium\.com/tinder|blog\.twitch|"
    r"atlassian\.com/blog|coinbase\.com/blog|uber\.com/.*/blog)",
    re.I,
)


def is_eng(text: str) -> bool:
    blob = text or ""
    if INTENT_RE.search(blob) or COMPANY_HOW_RE.search(blob) or BLOG_NEEDLE_RE.search(blob):
        return True
    return False


def parse_year(text: str) -> str:
    found = YEAR_RE.findall(text or "")
    return found[-1] if found else "any"


def parse_topic(text: str) -> str:
    blob = (text or "").lower()
    hits = [name for name, pat in TOPICS if re.search(pat, blob, re.I)]
    return ",".join(hits[:3]) if hits else "unspecified"


def parse_company(text: str) -> tuple[str, str]:
    blob = (text or "").lower()
    for name, aliases, needles, home in COMPANIES:
        for n in needles:
            if n.lower() in blob:
                return name, home
    for name, aliases, needles, home in COMPANIES:
        for a in aliases:
            if len(a) <= 3:
                if re.search(rf"\b{re.escape(a)}\b", blob, re.I):
                    return name, home
            elif a.lower() in blob:
                return name, home
    return "unspecified", ""


def first_hand_url(text: str) -> str:
    urls = URL_RE.findall(text or "")
    for raw in urls:
        if BLOG_NEEDLE_RE.search(raw):
            return "yes"
        host = urlparse(raw).netloc.lower().replace("www.", "")
        if any(n.lower() in raw.lower() or n.lower() in host for _n, _a, needles, _h in COMPANIES for n in needles):
            return "yes"
    if urls:
        return "no"
    return "unknown"


def skip_reason(text: str) -> str:
    if LISTICLE_RE.search(text or ""):
        return "listicle"
    return "none"


def format_brief(text: str) -> str:
    company, home = parse_company(text)
    topic = parse_topic(text)
    year = parse_year(text)
    hand = first_hand_url(text)
    skip = skip_reason(text)
    lines = [
        "kind: first-hand-scale",
        f"company: {company}",
        f"topic: {topic}",
        f"year: {year}",
        f"blog_home: {home or 'unknown'}",
        f"first_hand_url: {hand}",
        f"skip: {skip}",
        "quota: 最多三則",
        "row: 公司｜主題｜年｜一句話問題（含尺度數字或系統名）",
        "gate: 必須是該公司工程部落格原文；禁行銷、禁招聘、禁 top-N 清單、禁二手轉述",
        "scale: 要有量級／延遲／可用性／成本，或具名系統；沒有尺度就不要列",
        "missing: 找不到就說沒有一手尺度文，不准編標題與 URL",
        "cite: 主張→原句→[公司工程部落格 (年)]",
        "source: 只用輸入連結或 blog_home 可核對的文；禁止倒 300 篇清單",
        "news: 這不是新聞門；有 Eng article 區塊時不要走 WATCH 觀察中",
        "",
        "rule: curate first-hand scale writeups by company+topic+year.",
    ]
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_eng("Netflix 有沒有工程文講推薦")
    assert is_eng("Uber 怎麼 scale 搜尋")
    assert is_eng("https://netflixtechblog.com/foo")
    assert is_eng("Discord 工程部落格")
    assert not is_eng("今天有什麼新庫")
    assert not is_eng("該不該買 NVDA")
    assert not is_eng("解釋搜尋機制是什麼")
    c, home = parse_company("Netflix 工程文講推薦 2024")
    assert c == "Netflix" and "netflixtechblog" in home
    assert "AI/ML" in parse_topic("Netflix 工程文講推薦")
    assert parse_year("2024 的 Discord 工程文") == "2024"
    assert first_hand_url("https://netflixtechblog.com/x") == "yes"
    assert first_hand_url("https://reuters.com/tech/x") == "no"
    assert skip_reason("top 10 engineering blogs") == "listicle"
    brief = format_brief("Stripe 怎麼做支付 ledger 2024")
    assert "company: Stripe" in brief
    assert "Payments" in brief
    assert "quota: 最多三則" in brief
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
    if not is_eng(blob):
        print("not_eng_article", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
