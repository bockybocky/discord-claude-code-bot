# -*- coding: utf-8 -*-
"""Classify HTML-artifact intent into a fidelity brief.

effective-html method, localized: route first, keep wireframes unfinished,
one credible prototype flow, preserve plan commitments.
Writes a self-contained grayscale HTML file for wireframe/plan/prototype.
Does not render in Discord. Does not invent visual polish.
"""
from __future__ import annotations

import argparse
import html
import os
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

KINDS = [
    (
        "wireframe",
        ("線框", "线框", "wireframe", "低保真", "灰階稿", "灰度稿"),
        "baoyu-design",
        "low",
        [
            "保持未完成：灰階、系統字、樸素框，禁止品牌色／漸層／陰影／插畫",
            "用真實標籤，禁止 lorem；低保真不是空白盒子",
            "結構未定才給 2–3 個方向，色差不算新方向",
        ],
    ),
    (
        "prototype",
        ("互動原型", "原型", "prototype", "可點", "working flow"),
        "baoyu-design",
        "working",
        [
            "只做能回答審查問題的一條可信流程，不要假產品十二屏",
            "先列會走到的狀態：載入／空／錯／成功／停用／手機",
            "死按鈕拿掉；真系統才做的動作要標邊界，不准假裝完成",
        ],
    ),
    (
        "mockup",
        ("mockup", "視覺稿", "高保真靜態", "設計這個畫面"),
        "baoyu-design",
        "visual",
        [
            "問的是層級／字／色才用靜態 mockup，不要為了完整去加假互動",
            "方向跟專案走，不要預設暗色儀表板＋通用卡片",
            "換題目視覺還成立＝太泛，重做構圖",
        ],
    ),
    (
        "plan",
        ("計畫頁", "计划页", "roadmap", "時程頁", "rollout", "實作順序"),
        "baoyu-design",
        "document",
        [
            "來源裡的範圍、順序、用語要認得出來，不准膨成策略文",
            "承諾與假設／未決題分開",
            "沒寫的時程、百分比、狀態徽章不准發明",
        ],
    ),
    (
        "diagram",
        ("架構圖", "架构图", "時序圖", "时序图", "狀態圖", "流程圖", "流程图", "sequence", "topology"),
        "fireworks-tech-graph",
        "diagram",
        [
            "先選關係模型：拓樸／時序／流程／狀態／層級／時間線／矩陣",
            "不要每題都畫同一種方框加箭頭",
            "標籤先讀得懂，再加互動；公司技術圖走 fireworks-tech-graph",
        ],
    ),
    (
        "eli5",
        ("eli5", "講到我看得懂", "當我完全不懂", "怎麼串", "請求怎麼走", "零背景"),
        "tujie",
        "visual-map",
        [
            "讀者零背景：先畫關係與流向，不要童言、不要檔案逐一唸",
            "大圖少字：方塊＋箭頭當主體，字只標邊界",
            "這是心智圖不是證據；一行 bug／該不該買不要出 HTML",
        ],
    ),
    (
        "explainer",
        ("圖解", "图解"),
        "tujie",
        "explainer",
        [
            "給完全外行人的一頁圖解走桌上 tujie（手繪 SVG、顏色帶語意）",
            "結尾必寫這東西不能拿來做什麼",
            "本線不寫圖解成品",
        ],
    ),
    (
        "notebook",
        ("手札", "筆記頁", "笔记本", "單頁筆記"),
        "shouzha",
        "notebook",
        [
            "單檔 HTML 筆記，離線可開",
            "禁止入場動畫（截圖／列印會變白）",
            "暗色與列印選擇器不要互踩",
        ],
    ),
    (
        "slides",
        ("投影片", "做簡報", "做简报", "ppt", "deck"),
        "baoyu-design",
        "slides",
        [
            "簡報走 baoyu-design，不要在 Discord 貼整份 HTML",
            "要可編輯 PPTX 才說匯出，不要假裝已是 PPT",
        ],
    ),
]

HTML_RE = re.compile(
    r"(線框|线框|wireframe|低保真|互動原型|原型|prototype|mockup|"
    r"設計這個畫面|设计这个画面|html\s*頁|單檔\s*html|自包含|"
    r"落地頁|landing\s*page|做一個頁面|做个页面|做個頁面|"
    r"儀表板頁|仪表板页|做成手札|圖解|图解|"
    r"架構圖|架构图|時序圖|时序图|狀態圖|流程圖|流程图|"
    r"投影片|做簡報|做简报|計畫頁|计划页|roadmap|"
    r"eli5|講到我看得懂|當我完全不懂|怎麼串)",
    re.I,
)
NOT_HTML_RE = re.compile(
    r"(這張圖是|这张图是|財報|10-K|該不該買|持倉巡視)"
)
WRITE_KINDS = {"wireframe", "prototype", "plan", "mockup", "report", "eli5"}
NEST_DEFAULT = Path(r"D:\ai-memory\research\athena_insights\html")


def is_html_artifact(text: str) -> bool:
    blob = text or ""
    if NOT_HTML_RE.search(blob) and not HTML_RE.search(blob):
        return False
    return bool(HTML_RE.search(blob))


def classify(text: str) -> tuple[str, str, str, list[str]]:
    blob = (text or "").lower()
    best = "report"
    route = "baoyu-design"
    fidelity = "document"
    pitfalls = [
        "先寫觀眾與工作、形式、語氣、保真度、要不要互動",
        "單檔自包含；Discord 渲染不了，禁止假裝已交付 HTML",
        "真實內容，禁止占位文案與不能按的控件",
    ]
    best_hits = 0
    for name, keys, dest, fid, tips in KINDS:
        hits = sum(1 for k in keys if k.lower() in blob)
        if hits > best_hits:
            best_hits = hits
            best = name
            route = dest
            fidelity = fid
            pitfalls = tips
    if best_hits == 0:
        return "report", "baoyu-design", "document", pitfalls
    return best, route, fidelity, pitfalls


def nest_root() -> Path:
    raw = os.environ.get("ATHENA_HTML_NEST", "").strip()
    return Path(raw) if raw else NEST_DEFAULT


def slugify(text: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", (text or "").strip())[:40].strip("-")
    return s or "artifact"


def extract_title(text: str) -> str:
    blob = (text or "").strip().splitlines()[0]
    blob = re.sub(
        r"^(做一個|做個|做一份|畫個|幫我|請|eli5)?\s*",
        "",
        blob,
        flags=re.I,
    )
    blob = re.sub(r"(線框|原型|mockup|頁面|計畫頁)$", "", blob).strip()
    return blob[:80] or "未命名結構稿"


def extract_flow(text: str) -> list[str]:
    items = extract_items(text)
    if items:
        return items[:8]
    blob = text or ""
    if "→" in blob or "->" in blob:
        parts = re.split(r"\s*(?:→|->)\s*", blob)
        out = []
        for p in parts:
            s = re.sub(r"eli5|講到我看得懂|當我完全不懂|幫我", " ", p, flags=re.I)
            s = " ".join(s.split()).strip()[:40]
            if len(s) >= 2:
                out.append(s)
        return out[:8]
    return []


def extract_items(text: str) -> list[str]:
    items = []
    for line in (text or "").splitlines():
        s = line.strip()
        m = re.match(r"^(?:[-*]|[\d一二三四五六七八九十]+[、.．])\s*(.+)$", s)
        if m:
            items.append(m.group(1).strip()[:80])
    return items[:12]


def css_unfinished() -> str:
    return """
:root { --bg:#f4f4f4; --ink:#222; --mute:#666; --line:#bbb; --gap:1rem; }
* { box-sizing:border-box; }
html,body { margin:0; background:var(--bg); color:var(--ink);
  font: 16px/1.5 system-ui, "Segoe UI", sans-serif; }
a:focus-visible, button:focus-visible { outline: 2px solid #000; outline-offset:2px; }
header,nav,main,aside,footer { padding: var(--gap); }
header { border-bottom:1px solid var(--line); }
nav { display:flex; gap:var(--gap); flex-wrap:wrap; }
nav a { color:var(--ink); }
.block { border:1px solid var(--line); padding:var(--gap); margin:var(--gap) 0; background:#fff; }
.note { color:var(--mute); font-size:.9rem; }
.row { display:flex; gap:var(--gap); flex-wrap:wrap; }
.row > * { flex:1 1 12rem; }
button, .btn { border:1px solid var(--line); background:#eee; padding:.4rem .7rem; }
[data-out] { opacity:.7; }
@media (max-width: 40rem) { .row { display:block; } }
@media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
""".strip()


def css_eli5() -> str:
    return """
:root { --ink:#111; --bg:#fff; --box:#111; }
* { box-sizing:border-box; }
html,body { margin:0; background:var(--bg); color:var(--ink);
  font: 18px/1.3 system-ui, "Segoe UI", sans-serif; }
main { max-width: 28rem; margin: 0 auto; padding: 1.5rem; }
.stage { border: 4px solid var(--box); font-size: 1.8rem; font-weight: 700;
  text-align:center; padding: 1.6rem .8rem; margin: 0; }
.arrow { text-align:center; font-size: 2.2rem; line-height:1; margin: .2rem 0;
  color:var(--box); }
.note { color:#555; font-size: .95rem; }
h1 { font-size: 1.2rem; font-weight: 600; }
@media (prefers-reduced-motion: reduce) { * { animation:none !important; } }
""".strip()


def write_eli5_html(title: str, steps: list[str], dest: Path) -> Path:
    t = html.escape(title)
    if not steps:
        steps = ["進來", "處理", "出去"]
        note = "步驟不足，這三格只是骨架。用他的詞替換，不要編造中間層。"
    else:
        note = "心智圖，不是證據。要核對再去讀原始碼／日誌。"
    blocks = []
    for i, s in enumerate(steps):
        if i:
            blocks.append("<p class='arrow' aria-hidden='true'>↓</p>")
        blocks.append(f"<p class='stage'>{html.escape(s)}</p>")
    body = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title>
<style>{css_eli5()}</style>
</head>
<body>
<main>
  <p class="note">零背景・大圖少字・不是童言</p>
  <h1>{t}</h1>
  {"".join(blocks)}
  <p class="note">{html.escape(note)}</p>
</main>
</body>
</html>
"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(body, encoding="utf-8", newline="\n")
    return dest


def write_html(kind: str, title: str, items: list[str], dest: Path) -> Path:
    if kind == "eli5":
        return write_eli5_html(title, items, dest)
    t = html.escape(title)
    item_html = "".join(f"<li>{html.escape(x)}</li>" for x in items) or "<li>標籤待補（禁止 lorem）</li>"
    banner = {
        "wireframe": "線框・刻意未完成・審結構不審品牌",
        "prototype": "原型・一條流程・死按鈕已標出範圍",
        "plan": "計畫・只放來源裡有的承諾",
        "mockup": "靜態結構稿・視覺未定，不是成品",
        "report": "說明頁骨架・桌上再定視覺",
    }.get(kind, "結構稿")
    states = (
        "<aside class='block'><p class='note'>狀態（先列會走到的）</p>"
        "<ul><li>載入</li><li>空</li><li>錯</li><li>成功</li><li>停用</li><li>窄螢幕</li></ul></aside>"
        if kind == "prototype"
        else ""
    )
    plan_split = (
        "<section class='row'>"
        "<div class='block'><h2>已決</h2><p class='note'>只寫他已經拍板的。沒說的留空。</p></div>"
        "<div class='block'><h2>假設</h2><p class='note'>未核對的不要寫成承諾。</p></div>"
        "<div class='block'><h2>未決</h2><p class='note'>差他一句話才動的。</p></div>"
        "</section>"
        if kind == "plan"
        else ""
    )
    dead = (
        "<p><button type='button'>主行動</button> "
        "<button type='button' data-out title='真系統才做'>超出範圍</button></p>"
        if kind == "prototype"
        else ""
    )
    body = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title>
<style>{css_unfinished()}</style>
</head>
<body>
<a href="#main">跳到主內容</a>
<header>
  <p class="note">{html.escape(banner)}</p>
  <h1>{t}</h1>
</header>
<nav aria-label="區塊">
  <a href="#main">主內容</a>
  <a href="#list">清單</a>
</nav>
<div class="row">
<main id="main">
  <section class="block" id="list">
    <h2>畫面上要有的真實標籤</h2>
    <ul>{item_html}</ul>
    {dead}
  </section>
  {plan_split}
</main>
{states}
</div>
<footer class="note">單檔自包含。Discord 不渲染。瀏覽器寬／窄視窗尚未代驗。</footer>
</body>
</html>
"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(body, encoding="utf-8", newline="\n")
    return dest


def maybe_write(kind: str, text: str, root: Path | None = None) -> str:
    if kind not in WRITE_KINDS:
        return ""
    root = root or nest_root()
    name = f"{date.today().isoformat()}-{kind}-{slugify(extract_title(text))}.html"
    bits = extract_flow(text) if kind == "eli5" else extract_items(text)
    path = write_html(kind, extract_title(text), bits, root / name)
    return str(path.resolve())


def format_brief(text: str, artifact: str = "") -> str:
    kind, route, fidelity, pitfalls = classify(text)
    wrote = bool(artifact)
    lines = [
        f"kind: {kind}",
        f"fidelity: {fidelity}",
        f"route_to: {route}",
        f"delivery: {'file' if wrote else 'spec-only'}",
        f"artifact_path: {artifact or '（此類走桌上 ' + route + '，本線不寫檔）'}",
        "cannot_render: discord-oneshot 渲染不了 HTML；禁止貼整頁原始碼",
        "browser: unverified — 請他桌上開寬／窄視窗；不准假裝已驗",
        "settle: audience-job | form | register | fidelity | interaction",
        "authority: 他的指示 > 專案既有設計語言 > 題目與觀眾 > 你的品味",
        "originality: 換鄰近題目視覺還成立＝太泛，要重做構圖",
        "pitfalls:",
    ]
    lines.extend(f"  - {p}" for p in pitfalls)
    if kind == "prototype":
        lines.append("states_required: loading | empty | error | success | disabled | mobile | 題目特有狀態")
        lines.append("one_flow: 最小能驗的那一條，列清真系統接手前停在哪")
    if kind == "wireframe":
        lines.append("directions: 結構未定最多 2–3 個；已選定就只做一個")
    if kind == "plan":
        lines.append("preserve: 範圍／順序／用語；分開 已決 / 假設 / 未決")
    if kind == "diagram":
        lines.append("model_first: topology | sequence | process | state | hierarchy | timeline | matrix")
    if kind == "eli5":
        lines.append("eli5: 關係與流向；不准童言；圖≠證明；一行問題不要出頁")
    lines.extend(
        [
            "",
            "rule: route first; keep wireframes unfinished; one prototype flow;",
            "plans must not invent commitments. No HTML dump in Discord.",
        ]
    )
    return "\n".join(lines)


def run_selftest() -> int:
    assert is_html_artifact("做一個持倉頁線框")
    assert classify("做一個持倉頁線框")[0] == "wireframe"
    assert classify("做個互動原型")[0] == "prototype"
    assert classify("圖解一下稀釋")[0] == "explainer"
    assert classify("圖解一下稀釋")[1] == "tujie"
    assert classify("eli5 Discord → grok → 回覆")[0] == "eli5"
    assert classify("做成手札")[0] == "notebook"
    assert classify("畫個架構圖")[0] == "diagram"
    assert classify("做一份投影片")[0] == "slides"
    assert not is_html_artifact("這題該不該買 NVDA")
    with tempfile.TemporaryDirectory() as td:
        os.environ["ATHENA_HTML_NEST"] = td
        path = maybe_write(
            "wireframe",
            "做一個持倉頁線框\n- 曝險\n- 停損",
        )
        assert path
        body = Path(path).read_text(encoding="utf-8")
        assert "刻意未完成" in body
        assert "曝險" in body
        assert "lorem" not in body.lower()
        assert maybe_write("diagram", "畫個架構圖") == ""
        assert maybe_write("explainer", "圖解一下稀釋") == ""
        p2 = maybe_write("eli5", "eli5 Discord → grok → 回覆")
        assert p2 and "↓" in Path(p2).read_text(encoding="utf-8")
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
    if not is_html_artifact(blob):
        print("not_html_artifact", file=sys.stderr)
        return 3
    kind, _, _, _ = classify(blob)
    artifact = maybe_write(kind, blob)
    print(format_brief(blob, artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
