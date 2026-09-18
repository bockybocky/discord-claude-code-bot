# -*- coding: utf-8 -*-
"""Local file → Markdown for the LLM (MarkItDown method, localized).

Preserve headings, lists, tables. Analysis-grade, not pretty print.
convert_local only — no URI fetch, no Azure, no plugins.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

MAX_CHARS = 14_000
INTENT_RE = re.compile(
    r"(轉成?\s*markdown|转成?\s*markdown|markitdown|"
    r"這份\s*pdf|这份\s*pdf|讀這個\s*(?:ppt|pptx|docx|excel|xlsx)|"
    r"附件.{0,8}講什麼|附件.{0,8}讲什么)",
    re.I,
)
SKIP_EXT = {
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "mp3", "wav", "ogg", "m4a",
    "mp4", "mov", "exe", "dll", "zip",
}


def is_intent(text: str) -> bool:
    return bool(INTENT_RE.search(text or ""))


def format_policy() -> str:
    return "\n".join(
        [
            "kind: doc-markdown",
            "why: 模型吃結構 markdown，不是排版精美的人讀稿",
            "keep: 標題／清單／表格／連結；不要整份變一坨純文字",
            "local: 只轉本機附件；不准去抓任意 URL",
            "thin: 抽出字太少＝掃描件，說沒讀到，不准編頁碼",
            "cap: 長文截斷並標已截；不要要求把原檔再貼一次",
            "no: 不裝 markitdown、不開 Azure、不開外掛、不 OCR 金鑰",
            "",
            "rule: convert_local to markdown for the model.",
        ]
    )


def _cap(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_CHARS:
        return text, False
    return text[:MAX_CHARS].rstrip() + "\n\n[已截斷]", True


def _md_table(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    norm = [[(c or "").replace("\n", " ").strip() for c in r] for r in rows]
    width = max(len(r) for r in norm)
    for r in norm:
        while len(r) < width:
            r.append("")
    head, body = norm[0], norm[1:] or [[""] * width]
    lines = [
        "| " + " | ".join(head) + " |",
        "| " + " | ".join("---" for _ in head) + " |",
    ]
    for r in body[:40]:
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines)


def convert_txt(path: Path) -> tuple[str, str]:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "cp950", "latin-1"):
        try:
            return raw.decode(enc), "text"
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "replace"), "text"


def convert_html(path: Path) -> tuple[str, str]:
    from html.parser import HTMLParser

    class P(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.out: list[str] = []
            self.skip = 0

        def handle_starttag(self, tag, attrs):
            if tag in {"script", "style"}:
                self.skip += 1
            if tag in {"h1", "h2", "h3", "p", "li", "br", "tr"}:
                self.out.append("\n")

        def handle_endtag(self, tag):
            if tag in {"script", "style"} and self.skip:
                self.skip -= 1

        def handle_data(self, data):
            if not self.skip:
                self.out.append(data)

    p = P()
    p.feed(convert_txt(path)[0])
    return re.sub(r"\n{3,}", "\n\n", "".join(p.out)).strip(), "html-text"


def convert_pdf(path: Path) -> tuple[str, str, str]:
    try:
        import pdfplumber
    except ImportError:
        pdfplumber = None  # type: ignore
    if pdfplumber is not None:
        parts: list[str] = []
        with pdfplumber.open(path) as pdf:
            for i, page in enumerate(pdf.pages, 1):
                parts.append(f"<!-- page {i} -->")
                txt = page.extract_text() or ""
                if txt.strip():
                    parts.append(txt.strip())
                for tbl in page.extract_tables() or []:
                    md = _md_table([[str(c or "") for c in row] for row in tbl])
                    if md:
                        parts.append(md)
        body = "\n\n".join(parts).strip()
        note = "thin-scan" if len(body) < 100 else ""
        return body, "pdfplumber", note
    import fitz

    doc = fitz.open(path)
    parts = []
    for i in range(doc.page_count):
        parts.append(f"<!-- page {i + 1} -->")
        parts.append(doc.load_page(i).get_text("text") or "")
    doc.close()
    body = "\n\n".join(parts).strip()
    note = "thin-scan" if len(body) < 100 else ""
    return body, "pymupdf", note


def convert_docx(path: Path) -> tuple[str, str]:
    import docx

    d = docx.Document(str(path))
    parts: list[str] = []
    for p in d.paragraphs:
        t = (p.text or "").strip()
        if not t:
            continue
        name = (p.style.name or "") if p.style else ""
        m = re.search(r"(\d+)", name) if name.lower().startswith("heading") else None
        if m:
            parts.append("#" * min(int(m.group(1)), 6) + " " + t)
        else:
            parts.append(t)
    for table in d.tables:
        rows = [[c.text.strip() for c in row.cells] for row in table.rows]
        md = _md_table(rows)
        if md:
            parts.append(md)
    return "\n\n".join(parts), "python-docx"


def convert_pptx(path: Path) -> tuple[str, str]:
    from pptx import Presentation

    prs = Presentation(str(path))
    parts: list[str] = []
    for i, slide in enumerate(prs.slides, 1):
        parts.append(f"## 投影片 {i}")
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                t = shape.text_frame.text.strip()
                if t:
                    parts.append(t)
            if getattr(shape, "has_table", False):
                tbl = shape.table
                rows = [[c.text.strip() for c in row.cells] for row in tbl.rows]
                md = _md_table(rows)
                if md:
                    parts.append(md)
        if i >= 20:
            parts.append("[後續投影片已截斷]")
            break
    return "\n\n".join(parts), "python-pptx"


def convert_xlsx(path: Path) -> tuple[str, str]:
    import openpyxl

    wb = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
    parts: list[str] = []
    for si, name in enumerate(wb.sheetnames[:4]):
        ws = wb[name]
        parts.append(f"## {name}")
        rows: list[list[str]] = []
        for ri, row in enumerate(ws.iter_rows(values_only=True)):
            rows.append(["" if c is None else str(c) for c in row])
            if ri >= 40:
                break
        md = _md_table(rows)
        if md:
            parts.append(md)
    wb.close()
    return "\n\n".join(parts), "openpyxl"


def convert_epub(path: Path) -> tuple[str, str]:
    from ebooklib import ITEM_DOCUMENT, epub
    from bs4 import BeautifulSoup

    book = epub.read_epub(str(path))
    parts: list[str] = []
    for item in book.get_items():
        if item.get_type() == ITEM_DOCUMENT:
            txt = BeautifulSoup(item.get_content(), "html.parser").get_text("\n").strip()
            if txt:
                parts.append(txt)
    return "\n\n".join(parts), "ebooklib"


def convert_local(path: Path) -> dict:
    ext = path.suffix.lower().lstrip(".")
    note = ""
    converter = "none"
    body = ""
    if ext in SKIP_EXT:
        return {
            "ok": False,
            "converter": "skip",
            "note": f"{ext} 不走文字轉換（圖／音／影／壓縮檔）",
            "body": "",
        }
    try:
        if ext in {"txt", "md", "csv", "json"}:
            body, converter = convert_txt(path)
            if ext == "json":
                try:
                    body = json.dumps(json.loads(body), ensure_ascii=False, indent=2)
                except json.JSONDecodeError:
                    pass
        elif ext in {"html", "htm"}:
            body, converter = convert_html(path)
        elif ext == "pdf":
            body, converter, note = convert_pdf(path)
        elif ext == "docx":
            body, converter = convert_docx(path)
        elif ext == "pptx":
            body, converter = convert_pptx(path)
        elif ext in {"xlsx", "xlsm"}:
            body, converter = convert_xlsx(path)
        elif ext == "epub":
            body, converter = convert_epub(path)
        else:
            return {
                "ok": False,
                "converter": "unsupported",
                "note": f".{ext} 未接轉換",
                "body": "",
            }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "converter": converter, "note": str(e)[:200], "body": ""}
    body, clipped = _cap(body)
    if note == "thin-scan":
        return {
            "ok": False,
            "converter": converter,
            "note": "抽出字太少，可能是掃描件；沒讀到，不准編",
            "body": "",
        }
    if clipped:
        note = (note + " capped").strip()
    return {"ok": True, "converter": converter, "note": note, "body": body}


def emit_card(path: Path, result: dict) -> str:
    if not result["ok"]:
        return "\n".join(
            [
                "kind: doc-markdown",
                f"source: {path.name}",
                f"converter: {result['converter']}",
                f"status: CONVERT_FAILED",
                f"note: {result['note']}",
                "rule: 禁止假裝已讀原檔。",
            ]
        )
    body = result["body"]
    return "\n".join(
        [
            "kind: doc-markdown",
            f"source: {path.name}",
            f"converter: {result['converter']}",
            f"chars: {len(body)}",
            f"note: {result['note'] or 'ok'}",
            "keep: 標題／清單／表格",
            "",
            body,
        ]
    )


def run_selftest() -> int:
    tmp = Path(__file__).with_name("_tmp_file_to_md.txt")
    tmp.write_text("# 標題\n\n- 一\n- 二\n", encoding="utf-8")
    r = convert_local(tmp)
    assert r["ok"] and "標題" in r["body"]
    tmp.unlink(missing_ok=True)
    import docx

    dtmp = Path(__file__).with_name("_tmp_file_to_md.docx")
    doc = docx.Document()
    doc.add_heading("章節", level=1)
    doc.add_paragraph("內文一段")
    doc.save(dtmp)
    r = convert_local(dtmp)
    dtmp.unlink(missing_ok=True)
    assert r["ok"] and "# 章節" in r["body"] and "內文一段" in r["body"]
    assert is_intent("這份 PDF 轉成 markdown")
    assert not is_intent("該不該買 NVDA")
    print("selftest ok")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("path", nargs="?")
    p.add_argument("--brief", action="store_true")
    p.add_argument("--selftest", action="store_true")
    args = p.parse_args()
    if args.selftest:
        return run_selftest()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if args.brief or not args.path:
        print(format_policy())
        return 0
    raw = args.path
    if re.match(r"https?://", raw, re.I):
        print("kind: doc-markdown\nstatus: CONVERT_FAILED\nnote: 只轉本機檔，不抓 URL\n", file=sys.stderr)
        return 3
    path = Path(raw)
    if not path.is_file():
        print(f"kind: doc-markdown\nstatus: CONVERT_FAILED\nnote: 檔不存在\n", file=sys.stderr)
        return 3
    print(emit_card(path, convert_local(path)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
