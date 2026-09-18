# -*- coding: utf-8 -*-
"""Classify image-gen intent into a Prompt-as-Code brief.

awesome-gpt-image-2 method, localized: structure first, then style words.
Does not generate pixels. Does not call an image API.
"""
from __future__ import annotations

import argparse
import re
import sys

# Discord oneshot cannot render PNG. This brief only names the protocol.
DELIVERY = "prompt-only"

CATEGORIES = [
    (
        "ui",
        ("ui", "介面", "界面", "截圖", "截图", "dashboard", "mockup", "app 畫面", "app画面"),
        "9:16",
        [
            "先寫死平台＋比例＋佈局，不要只說「做一個介面」",
            "畫面上的字必須列在 text_lock，禁止亂碼按鈕",
            "指定平台特徵（iOS／Android／Web），禁止混搭",
        ],
    ),
    (
        "infographic",
        ("資訊圖", "信息图", "infographic", "知識圖", "流程圖", "對照圖", "explainer"),
        "16:9",
        [
            "模組數量寫死（3–5），指定圖表類型",
            "短句標籤，不要把大段正文塞進畫面",
            "禁止賽博龐克預設與亂碼字",
        ],
    ),
    (
        "poster",
        ("海報", "海报", "封面", "poster", "typography", "campaign"),
        "16:9",
        [
            "主視覺寫死，不要只說「做海報」",
            "標題／副標硬編碼，禁止模型自己加字",
            "單張完成圖，禁止 moodboard、過程稿、左右分割",
        ],
    ),
    (
        "product",
        ("商品", "主圖", "電商", "包装", "包裝", "產品照", "hero shot"),
        "1:1",
        [
            "材質＋燈光必須寫（磨砂、輪廓光），否則像地攤貨",
            "文案最多 1–2 句，不要貼滿促銷",
            "先定場景（棚拍／生活），再堆賣點",
        ],
    ),
    (
        "brand",
        ("logo", "品牌", "識別", "vi ", "字標"),
        "1:1",
        [
            "先品牌關鍵詞，再畫；Logo 不是插畫",
            "純白背景方便後製",
            "做減法，禁止噴火龍纏長城",
        ],
    ),
    (
        "architecture",
        ("建築", "室内", "室內", "空間", "效果圖", "interior"),
        "16:9",
        [
            "鎖人眼視角，壓住透視變形",
            "室外冷光對室內暖光",
            "寫死材質（木／石／金屬／玻璃）",
        ],
    ),
    (
        "photo",
        ("攝影", "寫實", "realism", "人像", "街拍", "35mm", "85mm"),
        "3:4",
        [
            "加一點瑕疵（膚質、膠片顆粒），避免假人",
            "用鏡頭參數（50mm、f/1.4）代替「淺景深」空話",
            "單一連貫空間，禁止左右各一個世界",
        ],
    ),
    (
        "illustration",
        ("插畫", "插画", "水彩", "厚塗", "日漫", "illustration"),
        "3:4",
        [
            "鎖筆觸（厚塗／水彩暈染），否則是預設塑膠風",
            "提大師時只借筆觸特徵，不要抄代表作構圖",
            "主體與背景主次寫死",
        ],
    ),
    (
        "character",
        ("角色", "人設", "人物設定", "toy", "pose sheet"),
        "3:4",
        [
            "五官拆開寫，不要只說「很美」",
            "服裝材質寫死",
            "系列圖先鎖同一張臉、同一套衣服",
        ],
    ),
    (
        "scene",
        ("分鏡", "場景", "storyboard", "敘事", "劇照"),
        "16:9",
        [
            "要有動詞（正在發生的事），不要風景明信片",
            "寫鏡頭語言（仰拍／中景／特寫）",
            "單一連貫瞬間，禁止拼貼兩個時空",
        ],
    ),
    (
        "history",
        ("古風", "朝代", "工筆", "水墨", "tang", "宋", "明"),
        "16:9",
        [
            "朝代寫死，禁止和服＋清朝扇＋唐宮大雜燴",
            "禁用現代元素（星巴克、手機）",
            "服飾結構要能對上該朝",
        ],
    ),
    (
        "document",
        ("雜誌", "內頁", "菜單", "白皮書", "畫冊", "排版"),
        "3:4",
        [
            "欄數與留白先寫，再堆風格詞",
            "正文用模擬字塊，只鎖大標題",
            "禁止指望模型排出整頁無錯字",
        ],
    ),
]

OTHER_PITFALLS = [
    "先寫用途，再寫視覺細節",
    "比例與禁忌寫死",
    "本線只交一版主提示詞，不要一次兩張完成圖",
]

GEN_RE = re.compile(
    r"(生圖|生图|畫一[張個]|画一[张个]|畫張|畫個|画张|画个|做封面|封面圖|封面图|"
    r"資訊圖|信息图|海報|海报|角色圖|角色图|示意圖|示意图|出一張圖|出一张图|"
    r"生成一張|生成一张|mockup|infographic|poster|generate an image|draw me|"
    r"風格庫|风格库|工业级提示|工業級提示|提示詞模板|做一張圖|做一张图|"
    r"ui 截圖|ui截圖|ui截图)",
    re.I,
)
ANALYZE_RE = re.compile(r"(這張圖是|这张图是|圖裡|图里|圖中寫|看這張圖|看这张图)")


def is_image_gen(text: str) -> bool:
    if ANALYZE_RE.search(text or "") and not GEN_RE.search(text or ""):
        return False
    return bool(GEN_RE.search(text or ""))


def classify(text: str) -> tuple[str, str, list[str]]:
    blob = (text or "").lower()
    best = "other"
    best_hits = 0
    ratio = "16:9"
    pitfalls = OTHER_PITFALLS
    for name, keys, default_ratio, tips in CATEGORIES:
        hits = sum(1 for k in keys if k.lower() in blob)
        if hits > best_hits:
            best_hits = hits
            best = name
            ratio = default_ratio
            pitfalls = tips
    if best_hits == 0:
        return "other", "16:9", OTHER_PITFALLS
    return best, ratio, pitfalls


def format_brief(text: str) -> str:
    cat, ratio, pitfalls = classify(text)
    lines = [
        f"category: {cat}",
        f"ratio_default: {ratio}",
        f"delivery: {DELIVERY}",
        "cannot_render: discord-oneshot 不產 PNG；禁止假裝已經生圖",
        "blocks: subject | layout | style | text_lock | ratio | constraints",
        "company_6: 用途／主體／風格／比例／構圖／禁忌",
        "structure_first: 先套本類結構，再填風格詞",
        "text_rule: 畫面上的字必須寫在 text_lock；禁止亂碼、lorem、模型自己加戲",
        "scene_rule: single continuous scene；對比用光與深度，禁止左右分割兩個世界",
        "pitfalls:",
    ]
    lines.extend(f"  - {p}" for p in pitfalls)
    lines.extend(
        [
            "",
            "rule: copy structure first, then style words.",
            "Fill the six blocks in Traditional Chinese for Charles;",
            "the copyable image prompt may include camera terms in English.",
        ]
    )
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_image_gen("幫我畫一張持倉風險資訊圖")
    assert classify("幫我畫一張持倉風險資訊圖")[0] == "infographic"
    assert classify("做一個 iOS App 介面")[0] == "ui"
    assert classify("封面海報 莊子")[0] == "poster"
    assert not is_image_gen("這張圖是什麼意思")
    assert classify("隨便生圖")[0] == "other"
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
    if not is_image_gen(blob):
        print("not_image_gen", file=sys.stderr)
        return 3
    print(format_brief(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
