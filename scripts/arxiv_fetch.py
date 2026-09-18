# -*- coding: utf-8 -*-
"""Fetch arXiv metadata+abstract, file into the local paper nest.

PaperNest method (naipings/PaperNest), localized:
same nest for card / glossary / writing snippet / related papers;
dedup by DOI / arXiv id / title; versions cross-link; unmatched → 未分類;
never write CCS trees or LaTeX crumbs into metadata.
Does not parse PDF. Does not call an LLM.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS_CANDIDATES = (
    "{http://arxiv.org/schemas/atom}",
    "{http://arxiv.org/schemas/arxiv}",
    "{http://www.arxiv.org/schemas/atom}",
)
ID_RE = re.compile(
    r"(?:arxiv\.org/(?:abs|pdf|html)/|arxiv:)(\d{4}\.\d{4,5})(v\d+)?",
    re.I,
)
CCS_RE = re.compile(
    r"(?is)\b(?:CCS Concepts?|CCS CONCEPTS|ACM Computing Classification(?: System)?)\b.*",
)
LATEX_INLINE_RE = re.compile(r"\$[^$]*\$")
LATEX_CMD_RE = re.compile(r"\\[a-zA-Z]+\*?\{([^{}]*)\}")
LATEX_BARE_RE = re.compile(r"\\[a-zA-Z]+\*?")
IEEE_WWW = re.compile(r"^(https?://)?(www\.)?ieee\.org/?$", re.I)
ACRONYM_EN_RE = re.compile(
    r"\b([A-Z][A-Za-z][\w-]{1,40}(?:\s+[A-Z][A-Za-z][\w-]{1,40}){0,4})\s+\(([A-Z]{2,12})\)"
)
ACRONYM_REV_RE = re.compile(
    r"\b([A-Z]{2,12})\s+\(([A-Z][A-Za-z][^)]{2,80})\)"
)
NAMED_RE = re.compile(
    r"(?:we propose|we present|we introduce)[^.!?]{0,120}?\b(?:the|a|an)\s+([A-Z][A-Za-z][\w-]{2,40})",
    re.I,
)
GLOSS_SKIP = {
    "the", "this", "these", "those", "our", "we", "in", "on", "for", "and",
    "experiments", "english", "german", "french", "test", "score", "model",
    "task", "results", "data", "training", "layer", "output", "state",
    "models", "tasks", "paper", "approach", "final", "combined", "these",
}
SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
NON_ALNUM_RE = re.compile(r"[^a-z0-9\u4e00-\u9fff]+")
TERM_STOP = {
    "the", "this", "that", "with", "from", "using", "based", "paper",
    "ours", "their", "these", "those", "into", "over",
}
NOTES_MARK = "## 閱讀批注"
NEST_DEFAULT = Path(r"D:\ai-memory\research\papers")

DEFAULT_DOMAINS = [
    {
        "id": "ml",
        "name": "機器學習",
        "arxiv": ["cs.LG", "cs.AI", "cs.CL", "stat.ML", "cs.NE", "cs.IR"],
        "keywords": ["transformer", "language model", "neural network", "attention", "llm", "bert", "gpt"],
    },
    {
        "id": "cv",
        "name": "電腦視覺",
        "arxiv": ["cs.CV"],
        "keywords": ["computer vision", "image recognition", "object detection"],
    },
    {
        "id": "robo",
        "name": "機器人",
        "arxiv": ["cs.RO"],
        "keywords": ["robot", "robotics"],
    },
    {
        "id": "semi",
        "name": "半導體與材料",
        "arxiv": ["cond-mat.mtrl-sci", "physics.app-ph", "cond-mat.mes-hall"],
        "keywords": ["photonic", "silicon photonics", "cmos", "gan", "semiconductor", "wafer"],
    },
    {
        "id": "opt",
        "name": "光學與光子",
        "arxiv": ["physics.optics", "eess.SP"],
        "keywords": ["photonics", "lidar", "optical interconnect"],
    },
    {
        "id": "quant",
        "name": "量化與市場",
        "arxiv": ["q-fin.ST", "q-fin.TR", "q-fin.PM", "q-fin.GN", "econ.GN", "econ.EM"],
        "keywords": ["option pricing", "portfolio", "market microstructure", "limit order"],
    },
]


def nest_root() -> Path:
    raw = os.environ.get("ATHENA_PAPER_NEST", "").strip()
    return Path(raw) if raw else NEST_DEFAULT


def parse_id(url: str) -> tuple[str, str] | None:
    raw = url.strip().rstrip(").,]>\"'")
    m = ID_RE.search(raw)
    if not m:
        return None
    base, ver = m.group(1), m.group(2) or ""
    return base, ver


def strip_latex(text: str) -> str:
    def unwrap(match: re.Match) -> str:
        body = match.group(0).strip("$")
        body = LATEX_CMD_RE.sub(r"\1", body)
        body = LATEX_BARE_RE.sub(" ", body)
        return f" {body} "

    s = LATEX_INLINE_RE.sub(unwrap, text or "")
    s = LATEX_CMD_RE.sub(r"\1", s)
    s = LATEX_BARE_RE.sub(" ", s)
    s = s.replace("{", " ").replace("}", " ")
    return re.sub(r"\s+", " ", s).strip()


def strip_ccs(text: str) -> str:
    return CCS_RE.sub("", text or "").strip()


def clean_text(text: str) -> str:
    return strip_latex(strip_ccs(re.sub(r"\s+", " ", text or "").strip()))


def clean_author(name: str) -> str:
    n = (name or "").strip()
    n = re.sub(r"[\s,]*[\d*†‡§¶#]+$", "", n)
    n = re.sub(r"\d+$", "", n).strip()
    return n


def clean_journal(text: str) -> str:
    j = clean_text(text)
    if IEEE_WWW.match(j.replace(" ", "")):
        return ""
    if j.lower() in {"www.ieee.org", "ieee.org"}:
        return ""
    return j


def title_norm(title: str) -> str:
    t = clean_text(title).lower()
    t = NON_ALNUM_RE.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip()


def sentences(text: str) -> list[str]:
    body = clean_text(text)
    if not body:
        return []
    parts = SENT_SPLIT_RE.split(body)
    return [p.strip() for p in parts if p.strip()]


def one_sentence_seed(abstract: str, limit: int = 240) -> str:
    sents = sentences(abstract)
    if not sents:
        return ""
    seed = sents[0]
    if len(seed) > limit:
        seed = seed[: limit - 1].rstrip() + "…"
    return seed


def source_sentence(term: str, abstract: str) -> str:
    needle = term.lower()
    for s in sentences(abstract):
        if needle in s.lower():
            return s
    return ""


def extract_glossary(abstract: str, limit: int = 8) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []

    def add(en: str, abbr: str, src: str) -> None:
        en = clean_text(en)
        abbr = (abbr or "").strip()
        key = (abbr or en).lower()
        if not en or key in seen:
            return
        words = [w for w in en.split() if w.lower() not in TERM_STOP]
        if not words:
            return
        seen.add(key)
        out.append({"term": en, "abbr": abbr, "src": src or source_sentence(en, abstract)})

    for m in ACRONYM_EN_RE.finditer(abstract or ""):
        add(m.group(1), m.group(2), "")
        if len(out) >= limit:
            return out
    for m in ACRONYM_REV_RE.finditer(abstract or ""):
        add(m.group(2), m.group(1), "")
        if len(out) >= limit:
            return out
    for m in NAMED_RE.finditer(abstract or ""):
        add(m.group(1), "", "")
        if len(out) >= limit:
            return out
    counts = Counter(re.findall(r"\b([A-Z][a-zA-Z][\w-]{2,30})\b", abstract or ""))
    for word, n in counts.most_common():
        if n < 2 or word.lower() in GLOSS_SKIP:
            continue
        add(word, "", "")
        if len(out) >= limit:
            return out
    caps = Counter(re.findall(r"\b([A-Z]{2,8})\b", abstract or ""))
    for word, n in caps.most_common():
        if n < 2 or word.lower() in GLOSS_SKIP:
            continue
        add(word, word, "")
        if len(out) >= limit:
            return out
    return out[:limit]


def extract_writing(abstract: str, limit: int = 2) -> list[str]:
    hits = []
    for s in sentences(abstract):
        low = s.lower()
        if any(k in low for k in ("we propose", "we present", "this paper", "our model", "we introduce")):
            hits.append(s)
        if len(hits) >= limit:
            break
    if not hits:
        hits = sentences(abstract)[:1]
    return hits[:limit]


def load_domains(root: Path) -> list[dict]:
    path = root / "domains.json"
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            items = data.get("domains") if isinstance(data, dict) else data
            if isinstance(items, list) and items:
                return items
        except json.JSONDecodeError:
            pass
    return DEFAULT_DOMAINS


def classify(categories: list[str], title: str, abstract: str, domains: list[dict]) -> str:
    cats = [c.strip() for c in categories if c and c.strip()]
    primary = cats[0] if cats else ""
    blob = f"{title} {abstract}".lower()
    for d in domains:
        arxiv = [x.lower() for x in d.get("arxiv") or []]
        if primary and primary.lower() in arxiv:
            return d.get("name") or "未分類"
    for d in domains:
        arxiv = [x.lower() for x in d.get("arxiv") or []]
        if any(c.lower() in arxiv for c in cats):
            return d.get("name") or "未分類"
    for d in domains:
        for kw in d.get("keywords") or []:
            if kw and re.search(r"\b" + re.escape(kw.lower()) + r"\b", blob):
                return d.get("name") or "未分類"
    return "未分類"


def token_set(text: str) -> set[str]:
    return {w for w in title_norm(text).split() if len(w) >= 4}


def related_score(me: dict, other: dict) -> int:
    score = 0
    if me.get("arxiv_primary") and me.get("arxiv_primary") == other.get("arxiv_primary"):
        score += 3
    mine = set(me.get("tags") or [])
    theirs = set(other.get("tags") or [])
    score += min(2, len(mine & theirs))
    score += min(4, len(token_set(me.get("title") or "") & token_set(other.get("title") or "")))
    return score


def version_num(ver: str) -> int:
    m = re.search(r"v(\d+)", ver or "", re.I)
    return int(m.group(1)) if m else 0


def related_line(oid: str, other: dict) -> str:
    return (
        f"{oid} {other.get('latest_version') or ''} | "
        f"{other.get('title') or ''} | {other.get('category') or '未分類'}"
    )


def patch_card_related(path: Path, lines: list[str]) -> None:
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")
    mark = "## 相關文獻（同巢，按領域／標題重疊）"
    i = text.find(mark)
    if i < 0:
        return
    notes_i = text.find(NOTES_MARK, i)
    block = (
        mark
        + "\n\n"
        + ("\n".join(f"- {x}" for x in lines) or "- （巢裡尚無同領域文獻）")
        + "\n\n"
    )
    text = text[:i] + block + (text[notes_i:] if notes_i >= 0 else "")
    atomic_write(path, text)


def patch_card_versions(path: Path, versions: list, latest: str) -> None:
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")
    ver_line = ", ".join(
        f"{v.get('version')} ({(v.get('updated') or '')[:10]})" for v in versions
    )
    text = re.sub(r"(?m)^- latest_version:.*$", f"- latest_version: {latest}", text, count=1)
    text = re.sub(r"(?m)^- versions:.*$", f"- versions: {ver_line}", text, count=1)
    atomic_write(path, text)


def pick_related(index: dict, arxiv_base: str, k: int = 5) -> list[str]:
    papers = index.get("papers") or {}
    me = papers.get(arxiv_base) or {}
    ranked = []
    for oid, other in papers.items():
        if oid == arxiv_base:
            continue
        sc = related_score(me, other)
        if sc <= 0:
            continue
        ranked.append((sc, other.get("updated") or "", oid))
    ranked.sort(reverse=True)
    return [oid for _, _, oid in ranked[:k]]


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name, suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def load_index(root: Path) -> dict:
    path = root / "index.json"
    if not path.is_file():
        return {"version": 1, "papers": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("papers/index.json is not an object")
    data.setdefault("version", 1)
    data.setdefault("papers", {})
    return data


def existing_notes(card_path: Path) -> str:
    if not card_path.is_file():
        return f"{NOTES_MARK}\n（尚無；未讀 PDF，禁止編頁碼。）\n"
    text = card_path.read_text(encoding="utf-8")
    i = text.find(NOTES_MARK)
    if i >= 0:
        return text[i:].rstrip() + "\n"
    return f"{NOTES_MARK}\n（尚無；未讀 PDF，禁止編頁碼。）\n"


def format_md_card(rec: dict, nest_info: dict, notes: str) -> str:
    authors = ", ".join(rec["authors"][:12])
    if len(rec["authors"]) > 12:
        authors += ", …"
    vers = rec.get("versions") or []
    ver_line = ", ".join(
        f"{v.get('version')} ({(v.get('updated') or '')[:10]})" for v in vers
    )
    related_lines = nest_info.get("related_lines") or []
    related_block = "\n".join(f"- {x}" for x in related_lines) or "- （巢裡尚無同領域文獻）"
    gloss_lines = []
    for g in rec.get("glossary") or []:
        abbr = f" ({g['abbr']})" if g.get("abbr") and g["abbr"].lower() != g["term"].lower() else ""
        src = g.get("src") or ""
        gloss_lines.append(f"- {g['term']}{abbr} — 原句：{src}")
    gloss_block = "\n".join(gloss_lines) or "- （abstract 抽不到術語對；不准發明）"
    write_block = "\n".join(f"- {s}" for s in rec.get("writing") or []) or "- （無）"
    dup = nest_info.get("possible_duplicate") or ""
    dup_line = f"**可能重複：** {dup}\n" if dup else ""
    return (
        f"# {rec['title']}\n\n"
        f"- arxiv_base: {rec['arxiv_base']}\n"
        f"- latest_version: {rec['latest_version']}\n"
        f"- versions: {ver_line or rec['latest_version']}\n"
        f"- doi: {rec.get('doi') or ''}\n"
        f"- category: {rec['category']}\n"
        f"- tags: {', '.join(rec.get('tags') or [])}\n"
        f"- folder: arxiv-inbox\n"
        f"- stage: metadata+abstract\n"
        f"- pdf: not-read\n"
        f"- authors: {authors}\n"
        f"- published: {rec.get('published') or ''}\n"
        f"- updated: {rec.get('updated') or ''}\n"
        f"- journal: {rec.get('journal') or ''}\n"
        f"- source_url: {rec.get('source_url') or ''}\n"
        f"{dup_line}"
        f"\n## 一句話種子（abstract 首句，Discord 再寫正式總結）\n\n"
        f"{rec.get('one_sentence_seed') or '（無）'}\n\n"
        f"## Abstract\n\n"
        f"{rec.get('summary') or ''}\n\n"
        f"## 雙語術語（英文＋原句；中文由 Discord 填，禁止無原句發明）\n\n"
        f"{gloss_block}\n\n"
        f"## 寫作素材（abstract 原句）\n\n"
        f"{write_block}\n\n"
        f"## 相關文獻（同巢，按領域／標題重疊）\n\n"
        f"{related_block}\n\n"
        f"{notes}"
    )


def init_nest(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "cards").mkdir(exist_ok=True)
    domains_path = root / "domains.json"
    if not domains_path.is_file():
        atomic_write(
            domains_path,
            json.dumps({"domains": DEFAULT_DOMAINS}, ensure_ascii=False, indent=2) + "\n",
        )
    readme = root / "README.md"
    if not readme.is_file():
        atomic_write(
            readme,
            (
                "# Athena 本地論文巢\n\n"
                "PaperNest 方法在地化：論文卡、術語、寫作句、相關文獻同庫。"
                "資料只在本機 vault。AthenaBot 貼 arXiv 連結時由 `arxiv_fetch.py` 入巢。\n\n"
                "- 去重：DOI／arXiv 號／標題\n"
                "- 不同 arXiv 版本＝歷史版本，交叉引用，不當兩篇新論文\n"
                "- 詞表對不上 → 分類維持「未分類」\n"
                "- 不寫 CCS 分類樹、LaTeX 殘片、作者上標\n"
                "- 預設不讀 PDF、不連 Crossref\n"
                "- 詞表：`domains.json`（可改；改了不會被腳本覆寫）\n"
            ),
        )


def upsert_nest(root: Path, rec: dict) -> dict:
    init_nest(root)
    index = load_index(root)
    papers = index["papers"]
    base = rec["arxiv_base"]
    prev = papers.get(base) or {}
    prev_versions = list(prev.get("versions") or [])
    ver = rec["latest_version"]
    seen_vers = {v.get("version") for v in prev_versions}
    if ver not in seen_vers:
        prev_versions.append(
            {"version": ver, "updated": rec.get("updated") or "", "id": rec.get("id") or ""}
        )
    else:
        for v in prev_versions:
            if v.get("version") == ver:
                v["updated"] = rec.get("updated") or v.get("updated") or ""
                v["id"] = rec.get("id") or v.get("id") or ""
    prev_versions.sort(key=lambda v: version_num(v.get("version") or ""))
    rec["versions"] = prev_versions
    stored_latest = prev.get("latest_version") or ""
    incoming_is_older = bool(prev) and version_num(ver) < version_num(stored_latest)

    status = "new"
    if prev:
        if incoming_is_older:
            status = "old-version"
        elif ver not in seen_vers:
            status = "new-version"
        else:
            status = "updated"

    possible = ""
    tnorm = rec["title_norm"]
    doi = (rec.get("doi") or "").strip().lower()
    for oid, other in papers.items():
        if oid == base:
            continue
        if doi and (other.get("doi") or "").strip().lower() == doi:
            possible = f"doi:{oid}"
            break
        if tnorm and other.get("title_norm") == tnorm:
            possible = f"title:{oid}"
            break

    card_rel = f"cards/{base}.md"
    if incoming_is_older:
        entry = dict(prev)
        entry["versions"] = prev_versions
        papers[base] = entry
        patch_card_versions(root / card_rel, prev_versions, stored_latest)
        related = list(entry.get("related") or [])
        related_lines = []
        for oid in related:
            o = papers.get(oid) or {}
            related_lines.append(
                f"{oid} {o.get('latest_version') or ''} | {o.get('title') or ''} | {o.get('category') or '未分類'}"
            )
        nest_info = {
            "status": status,
            "path": str((root / card_rel).resolve()),
            "related": related,
            "related_lines": related_lines,
            "possible_duplicate": possible,
            "versions": prev_versions,
            "latest": stored_latest,
        }
        index["as_of"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        atomic_write(root / "index.json", json.dumps(index, ensure_ascii=False, indent=2) + "\n")
        return nest_info

    entry = {
        "arxiv_base": base,
        "doi": rec.get("doi") or "",
        "title": rec["title"],
        "title_norm": tnorm,
        "latest_version": ver,
        "versions": prev_versions,
        "category": rec["category"],
        "arxiv_primary": rec.get("arxiv_primary") or "",
        "tags": rec.get("tags") or [],
        "folder": "arxiv-inbox",
        "card": card_rel,
        "updated": rec.get("updated") or "",
        "published": rec.get("published") or "",
        "source": "athenabot",
        "pdf": "not-read",
    }
    papers[base] = entry

    related = pick_related(index, base)
    entry["related"] = related
    for oid in set(related):
        other = papers.get(oid)
        if not other:
            continue
        others_rel = [x for x in (other.get("related") or []) if x != base]
        if base not in others_rel:
            others_rel.insert(0, base)
        other["related"] = others_rel[:5]

    related_lines = [related_line(oid, papers.get(oid) or {}) for oid in related]

    nest_info = {
        "status": status,
        "path": str((root / card_rel).resolve()),
        "related": related,
        "related_lines": related_lines,
        "possible_duplicate": possible,
        "versions": prev_versions,
        "latest": ver,
    }
    notes = existing_notes(root / card_rel)
    atomic_write(root / card_rel, format_md_card(rec, nest_info, notes))
    for oid in related:
        other = papers.get(oid) or {}
        sib = other.get("card")
        if not sib:
            continue
        sib_lines = [related_line(rid, papers.get(rid) or {}) for rid in (other.get("related") or [])]
        patch_card_related(root / sib, sib_lines)
    index["as_of"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    atomic_write(root / "index.json", json.dumps(index, ensure_ascii=False, indent=2) + "\n")
    return nest_info


def fetch_atom(arxiv_id: str) -> dict:
    req = urllib.request.Request(
        f"https://export.arxiv.org/api/query?id_list={arxiv_id}",
        headers={"User-Agent": "AthenaBot/1.0 (research; local)"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = resp.read()
    root = ET.fromstring(payload)
    entry = root.find(f"{ATOM}entry")
    if entry is None:
        raise RuntimeError(f"arxiv id not found: {arxiv_id}")

    def text(tag: str) -> str:
        node = entry.find(f"{ATOM}{tag}")
        return (node.text or "").strip() if node is not None else ""

    authors = []
    for a in entry.findall(f"{ATOM}author"):
        node = a.find(f"{ATOM}name")
        if node is not None and node.text:
            name = clean_author(node.text)
            if name:
                authors.append(name)
    cats = [
        c.attrib.get("term", "")
        for c in entry.findall(f"{ATOM}category")
        if c.attrib.get("term")
    ]
    ident = text("id")
    version = ""
    vm = re.search(r"(v\d+)$", ident)
    if vm:
        version = vm.group(1)
    def arxiv_field(tag: str) -> str:
        for ns in ARXIV_NS_CANDIDATES:
            node = entry.find(f"{ns}{tag}")
            if node is not None and (node.text or "").strip():
                return (node.text or "").strip()
        return ""

    title = clean_text(text("title"))
    summary = clean_text(text("summary"))
    primary = ""
    for ns in ARXIV_NS_CANDIDATES:
        node = entry.find(f"{ns}primary_category")
        if node is not None and node.attrib.get("term"):
            primary = node.attrib.get("term") or ""
            break
    return {
        "id": ident,
        "title": title,
        "summary": summary,
        "published": text("published"),
        "updated": text("updated"),
        "authors": authors,
        "categories": cats,
        "version": version,
        "comment": clean_text(arxiv_field("comment")),
        "doi": clean_text(arxiv_field("doi")),
        "journal": clean_journal(arxiv_field("journal_ref")),
        "arxiv_primary": primary or (cats[0] if cats else ""),
    }


def build_record(url: str, data: dict, domains: list[dict]) -> dict:
    ident = data.get("id") or ""
    base = ""
    parsed = parse_id(ident) or parse_id(url)
    if parsed:
        base = parsed[0]
    ver = data.get("version") or (parsed[1] if parsed and parsed[1] else "unknown")
    cats = data.get("categories") or []
    title = data["title"]
    summary = data["summary"]
    return {
        "id": ident,
        "arxiv_base": base,
        "latest_version": ver,
        "title": title,
        "title_norm": title_norm(title),
        "summary": summary,
        "authors": data.get("authors") or [],
        "published": data.get("published") or "",
        "updated": data.get("updated") or "",
        "tags": cats,
        "arxiv_primary": data.get("arxiv_primary") or (cats[0] if cats else ""),
        "category": classify(cats, title, summary, domains),
        "comment": data.get("comment") or "",
        "doi": data.get("doi") or "",
        "journal": data.get("journal") or "",
        "source_url": url,
        "one_sentence_seed": one_sentence_seed(summary),
        "glossary": extract_glossary(summary),
        "writing": extract_writing(summary),
    }


def format_card(rec: dict, nest_info: dict | None) -> str:
    authors = ", ".join(rec["authors"][:8])
    if len(rec["authors"]) > 8:
        authors += ", …"
    nest_info = nest_info or {}
    vers = nest_info.get("versions") or rec.get("versions") or []
    if vers:
        ver_txt = "; ".join(
            f"{v.get('version')} ({(v.get('updated') or '')[:10]})" for v in vers
        )
    else:
        ver_txt = rec.get("latest_version") or "unknown"
    related_lines = nest_info.get("related_lines") or []
    gloss = rec.get("glossary") or []
    gloss_txt = (
        " | ".join(
            f"{g['term']}"
            + (
                f" ({g['abbr']})"
                if g.get("abbr") and g["abbr"].lower() != g["term"].lower()
                else ""
            )
            + f" ← {g.get('src') or ''}"
            for g in gloss
        )
        if gloss
        else "（abstract 抽不到術語對；不准發明）"
    )
    lines = [
        f"canonical_id: {rec.get('id') or rec['arxiv_base']}",
        f"arxiv_base: {rec['arxiv_base']}",
        f"version: {rec.get('latest_version') or 'unknown'}",
        f"nest_latest: {nest_info.get('latest') or rec.get('latest_version') or 'unknown'}",
        f"versions_in_nest: {ver_txt}",
        "stage: metadata+abstract  (pdf=not-read)",
        "delivery: incomplete-for-pdf-analysis",
        f"title: {rec['title']}",
        f"authors: {authors}",
        f"published: {rec['published']}",
        f"updated: {rec['updated']}",
        f"categories: {', '.join(rec.get('tags') or [])}",
        f"category: {rec['category']}",
        f"folder: arxiv-inbox",
        f"comment: {rec.get('comment') or ''}",
        f"doi: {rec.get('doi') or ''}",
        f"journal: {rec.get('journal') or ''}",
        f"source_url: {rec.get('source_url') or ''}",
        f"nest_status: {nest_info.get('status') or 'skipped'}",
        f"nest_path: {nest_info.get('path') or ''}",
        f"possible_duplicate: {nest_info.get('possible_duplicate') or ''}",
        f"one_sentence_seed: {rec.get('one_sentence_seed') or ''}",
        f"glossary: {gloss_txt}",
        "related:",
    ]
    if related_lines:
        lines.extend(f"  - {x}" for x in related_lines)
    else:
        lines.append("  - （巢裡尚無同領域文獻）")
    lines.extend(
        [
            "",
            "abstract:",
            rec.get("summary") or "",
            "",
            "rule: filed into local nest; PDF was not parsed.",
            "Do not claim you read the full paper. CHEAP path = 一句話總結 from abstract.",
            "Bilingual glossary: only terms listed above; give 中文釋義 from the source sentence.",
            "If category is 未分類, keep it unclassified. Do not force a domain.",
            "Do not copy CCS trees, LaTeX crumbs, or author superscripts into the reply.",
            "SMART/PDF path only if the user asked 深挖/全文 and you still only have this card → say PDF unread.",
        ]
    )
    return "\n".join(lines)


def run_selftest() -> int:
    latexed = strip_latex(r"A $\alpha$-study of nets")
    assert "$" not in latexed and "study" in latexed.lower(), latexed
    assert "CCS" not in strip_ccs("Hello. CCS Concepts: Computing → LLM; more")
    assert clean_journal("www.ieee.org") == ""
    assert clean_author("Wei Zhang1,*") == "Wei Zhang"
    astro = classify(["astro-ph.CO"], "Planck 2018 results", "cosmology cmb", DEFAULT_DOMAINS)
    assert astro == "未分類", astro
    ml = classify(["cs.LG", "cs.CL"], "Attention Is All You Need", "transformer attention", DEFAULT_DOMAINS)
    assert ml == "機器學習", ml
    gloss = extract_glossary(
        "We introduce the Transformer (TRM), a model based on attention."
    )
    assert any(g.get("abbr") == "TRM" for g in gloss), gloss
    named = extract_glossary(
        "We propose a new simple network architecture, the Transformer, based solely on attention. The Transformer generalizes well."
    )
    assert any(g.get("term") == "Transformer" for g in named), named
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        domains = load_domains(root)
        rec = build_record(
            "https://arxiv.org/abs/1706.03762v7",
            {
                "id": "http://arxiv.org/abs/1706.03762v7",
                "title": "Attention Is All You Need",
                "summary": "We propose a new simple network architecture, the Transformer (TRM), based solely on attention mechanisms.",
                "published": "2017-06-12T00:00:00Z",
                "updated": "2023-08-02T00:00:00Z",
                "authors": ["Ashish Vaswani"],
                "categories": ["cs.CL", "cs.LG"],
                "version": "v7",
                "comment": "15 pages",
                "doi": "10.5555/3295222.3295349",
                "journal": "",
            },
            domains,
        )
        info1 = upsert_nest(root, rec)
        rec_v1 = dict(rec)
        rec_v1["latest_version"] = "v1"
        rec_v1["id"] = "http://arxiv.org/abs/1706.03762v1"
        rec_v1["updated"] = "2017-06-12T00:00:00Z"
        rec_v1["summary"] = "OLD ABSTRACT should not clobber v7"
        rec_v1["one_sentence_seed"] = "OLD ABSTRACT should not clobber v7"
        info2 = upsert_nest(root, rec_v1)
        idx = load_index(root)
        paper = idx["papers"]["1706.03762"]
        vers = {v["version"] for v in paper["versions"]}
        assert vers == {"v1", "v7"}, vers
        assert paper["latest_version"] == "v7", paper
        card = (root / "cards" / "1706.03762.md").read_text(encoding="utf-8")
        assert "OLD ABSTRACT" not in card
        assert info1["status"] == "new"
        assert info2["status"] == "old-version"
        rec2 = build_record(
            "https://arxiv.org/abs/1810.04805",
            {
                "id": "http://arxiv.org/abs/1810.04805v2",
                "title": "BERT: Pre-training of Deep Bidirectional Transformers",
                "summary": "We introduce BERT (Bidirectional Encoder Representations from Transformers).",
                "published": "2018-10-11T00:00:00Z",
                "updated": "2019-05-24T00:00:00Z",
                "authors": ["Jacob Devlin"],
                "categories": ["cs.CL"],
                "version": "v2",
                "comment": "",
                "doi": "",
                "journal": "",
            },
            domains,
        )
        info3 = upsert_nest(root, rec2)
        assert any("1706.03762" in x for x in info3.get("related_lines") or []), info3
        rec_dup = dict(rec)
        rec_dup["arxiv_base"] = "9999.99999"
        rec_dup["latest_version"] = "v1"
        rec_dup["id"] = "http://arxiv.org/abs/9999.99999v1"
        info4 = upsert_nest(root, rec_dup)
        assert "doi:" in (info4.get("possible_duplicate") or ""), info4
        card = (root / "cards" / "1706.03762.md").read_text(encoding="utf-8")
        assert "CCS" not in card
        assert NOTES_MARK in card
    print("selftest ok")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("url", nargs="?")
    p.add_argument("--selftest", action="store_true")
    args = p.parse_args()
    if args.selftest:
        return run_selftest()
    if not args.url:
        print("need url or --selftest", file=sys.stderr)
        return 2
    parsed = parse_id(args.url)
    if parsed is None:
        print("not an arxiv abs/pdf URL", file=sys.stderr)
        return 2
    base, ver = parsed
    arxiv_id = base + ver
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        data = fetch_atom(arxiv_id)
    except (urllib.error.URLError, RuntimeError, ET.ParseError) as e:
        print(str(e), file=sys.stderr)
        return 1
    root = nest_root()
    domains = load_domains(root)
    rec = build_record(args.url.strip(), data, domains)
    nest_info: dict | None
    try:
        nest_info = upsert_nest(root, rec)
    except Exception as e:
        nest_info = {"status": f"FAILED:{e}", "path": "", "related_lines": [], "versions": []}
    print(format_card(rec, nest_info))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
