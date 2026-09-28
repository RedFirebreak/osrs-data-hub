#!/usr/bin/env python3
"""Keep a gotcha registry (docs/gotchas/) internally consistent.

    python check_gotchas.py              validate; prints OK or every problem found
    python check_gotchas.py next PFX     print the next free ID for a prefix (retired numbers count)
    python check_gotchas.py ids          print the highest ID in use per prefix
    python check_gotchas.py init         scaffold docs/gotchas/ and copy this script to tools/
    python check_gotchas.py --hook       PostToolUse hook mode: reads the event JSON from stdin,
                                         validates after markdown edits, exit 2 + stderr on failure

Options: --dir PATH  registry directory (default: docs/gotchas, searched for upward from cwd).

Area files are discovered by globbing *.md in the registry, minus README.md and open-questions.md,
so a new area needs no change here. Stdlib only.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

DEFAULT_DIR = Path("docs/gotchas")
NON_AREA = {"README.md", "open-questions.md"}
ID_RE = r"[A-Z][A-Z0-9]*-\d+"
ID_FULL = re.compile(rf"^{ID_RE}$")
ANCHOR_ID = re.compile(r"^[a-z][a-z0-9]*-\d+$")
LINK = re.compile(r"\]\(([^)\s#]*)(?:#([^)\s]+))?\)")

ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
        "fifteen sixteen seventeen eighteen nineteen").split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def number_word(n: int) -> str:
    if n < 20:
        return ONES[n]
    if n < 100:
        t, o = divmod(n, 10)
        return TENS[t] + ("" if o == 0 else "-" + ONES[o])
    return str(n)


def id_key(i: str) -> tuple[str, int]:
    p, n = i.rsplit("-", 1)
    return p, int(n)


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8").replace("\r\n", "\n")


def cells(line: str) -> list[str] | None:
    s = line.strip()
    if not s.startswith("|") or re.fullmatch(r"\|[\s:|-]*\|", s):
        return None
    return [c.strip() for c in re.split(r"(?<!\\)\|", s)[1:-1]]


def sections(text: str) -> dict[str, str]:
    """Split on '## ' headings. Key '' is everything before the first one."""
    out, key, buf = {}, "", []
    for line in text.split("\n"):
        m = re.match(r"^## (.+?)\s*$", line)
        if m:
            out[key] = "\n".join(buf)
            key, buf = m.group(1), []
        else:
            buf.append(line)
    out[key] = "\n".join(buf)
    return out


def find_dir(explicit: str | None) -> Path | None:
    if explicit:
        d = Path(explicit)
        return d if (d / "README.md").is_file() else None
    starts = [Path(os.environ["CLAUDE_PROJECT_DIR"])] if os.environ.get("CLAUDE_PROJECT_DIR") else []
    starts.append(Path.cwd())
    for start in starts:
        for base in [start, *start.resolve().parents]:
            if (base / DEFAULT_DIR / "README.md").is_file():
                return base / DEFAULT_DIR
    return None


# ---------------------------------------------------------------- parsing

class Area:
    def __init__(self, path: Path):
        self.path, self.name = path, path.name
        self.text = read(path)
        self.headings: list[str] = re.findall(r"^### (.+?)\s*$", self.text, re.M)
        head = self.text.split("\n### ", 1)[0]
        self.table: list[tuple[str, str, str]] = []  # (id, anchor, symptom)
        for line in head.split("\n"):
            c = cells(line)
            if c and len(c) >= 2:
                m = re.fullmatch(rf"\[({ID_RE})\]\(#([^)]+)\)", c[0])
                if m:
                    self.table.append((m.group(1), m.group(2), c[1]))
        self.bodies: dict[str, str] = {}
        parts = re.split(r"^### (.+?)\s*$", self.text, flags=re.M)
        for i in range(1, len(parts), 2):
            self.bodies[parts[i]] = parts[i + 1]


class Readme:
    def __init__(self, path: Path):
        self.path = path
        self.text = read(path)
        sec = sections(self.text)
        self.head = sec.get("", "")
        self.index_text = sec.get("Index", "")
        self.retired_text = sec.get("Retired IDs", "")
        self.opening = re.search(r"(\d+) traps?, grouped into ([\w-]+) files?", self.head)

        self.files: dict[str, tuple[list[str], str]] = {}  # name -> (prefixes, count cell)
        for line in self.head.split("\n"):
            c = cells(line)
            if c and len(c) == 3:
                m = re.fullmatch(r"\[([^\]]+\.md)\]\(([^)]+)\)", c[0])
                if m:
                    owned = c[1].split("—", 1)[0]
                    self.files[m.group(2)] = (re.findall(r"`([A-Z][A-Z0-9]*)`", owned), c[2])

        m = re.search(r"\*\*Source key\.\*\*(.*?)(?:\n\s*\n|\Z)", self.head, re.S)
        self.source_keys = set(re.findall(r"`([A-Z][A-Z_]*)`", m.group(1))) if m else set()

        self.index: list[tuple[str, list[tuple[str, str, str, str]]]] = []  # (file, [(id, target, area, symptom)])
        for line in self.index_text.split("\n"):
            c = cells(line)
            if not c or len(c) < 3:
                continue
            g = re.fullmatch(r"\*\*\[([^\]]+\.md)\]\(([^)]+)\)\*\*", c[0])
            if g:
                self.index.append((g.group(2), []))
                continue
            e = re.fullmatch(rf"\[({ID_RE})\]\(([^)]+)\)", c[0])
            if e:
                if not self.index:
                    self.index.append(("", []))
                self.index[-1][1].append((e.group(1), e.group(2), c[1], c[2]))

        self.retired: dict[str, str] = {}
        for line in self.retired_text.split("\n"):
            c = cells(line)
            if c and len(c) >= 2 and ID_FULL.match(c[0]):
                self.retired[c[0]] = c[1]


def load(d: Path) -> tuple[Readme, list[Area]]:
    areas = sorted((Area(p) for p in d.glob("*.md") if p.name not in NON_AREA), key=lambda a: a.name)
    return Readme(d / "README.md"), areas


# ---------------------------------------------------------------- checks

def check(d: Path) -> list[str]:
    errs: list[str] = []
    rd, areas = load(d)
    by_name = {a.name: a for a in areas}
    live: dict[str, str] = {}

    # --- each area file on its own
    for a in areas:
        bad = [h for h in a.headings if not ID_FULL.match(h)]
        for h in bad:
            errs.append(f"{a.name}: heading '### {h}' is not an ID like ABC-12 (use #### for sub-headings)")
        ids = [h for h in a.headings if ID_FULL.match(h)]
        if ids != sorted(ids, key=id_key):
            errs.append(f"{a.name}: entries are not in ID order: {', '.join(ids)}")
        for i in ids:
            if i in live:
                errs.append(f"{i}: defined twice, in {live[i]} and {a.name}")
            live[i] = a.name
        t_ids = [t[0] for t in a.table]
        if t_ids != ids:
            missing, extra = set(ids) - set(t_ids), set(t_ids) - set(ids)
            if missing:
                errs.append(f"{a.name}: no row in the file's table for {', '.join(sorted(missing, key=id_key))}")
            if extra:
                errs.append(f"{a.name}: table row for {', '.join(sorted(extra, key=id_key))} with no ### entry")
            if not missing and not extra:
                errs.append(f"{a.name}: table rows are not in the same order as the entries")
        for i, anchor, _ in a.table:
            if anchor != i.lower():
                errs.append(f"{a.name}: table row {i} links to #{anchor}, expected #{i.lower()}")
        for i in ids:
            body = a.bodies.get(i, "").strip()
            if not body.startswith("**"):
                errs.append(f"{a.name}: {i} does not open with a bold symptom sentence")
            src = re.findall(r"^\*Source:(.*)$", body, re.M)
            if not src:
                errs.append(f"{a.name}: {i} has no '*Source: ...*' line")
            elif rd.source_keys and not any(k in s for s in src for k in rd.source_keys):
                errs.append(f"{a.name}: {i} source names none of the README's keys "
                            f"({', '.join(sorted(rd.source_keys))})")

    # --- README: opening sentence
    total = sum(len([h for h in a.headings if ID_FULL.match(h)]) for a in areas)
    if not rd.opening:
        errs.append("README.md: opening sentence 'N traps, grouped into <word> files' not found")
    else:
        if int(rd.opening.group(1)) != total:
            errs.append(f"README.md: opening sentence says {rd.opening.group(1)} traps, there are {total}")
        if rd.opening.group(2) != number_word(len(areas)):
            errs.append(f"README.md: opening sentence says '{rd.opening.group(2)}' files, "
                        f"there are {len(areas)} ('{number_word(len(areas))}')")

    # --- README: file table
    owner: dict[str, str] = {}
    for name, (prefixes, count) in rd.files.items():
        if not (d / name).is_file():
            errs.append(f"README.md: file table links to missing file {name}")
            continue
        if name in NON_AREA:
            continue
        for p in prefixes:
            if p in owner:
                errs.append(f"README.md: prefix {p} claimed by both {owner[p]} and {name}")
            owner[p] = name
        a = by_name[name]
        n = len([h for h in a.headings if ID_FULL.match(h)])
        if count != str(n):
            errs.append(f"README.md: file table says {name} has {count} entries, it has {n}")
    for a in areas:
        if a.name not in rd.files:
            errs.append(f"README.md: no row in the file table for {a.name}")
    for i, f in live.items():
        p = id_key(i)[0]
        if p not in owner:
            errs.append(f"{f}: prefix {p} ({i}) is not listed in README's file table")
        elif owner[p] != f:
            errs.append(f"{f}: {i} uses prefix {p}, which README's file table gives to {owner[p]}")

    # --- README: index
    groups = [g for g, _ in rd.index]
    want = [a.name for a in areas if a.headings]
    if groups != want:
        errs.append(f"README.md: index groups are [{', '.join(groups)}], expected [{', '.join(want)}] "
                    "(one bold group row per non-empty area file, in file-name order)")
    for g, rows in rd.index:
        a = by_name.get(g)
        if a is None:
            errs.append(f"README.md: index group links to missing file {g or '(no group row)'}")
            continue
        sym = {t[0]: t[2] for t in a.table}
        ids = [r[0] for r in rows]
        expected = [h for h in a.headings if ID_FULL.match(h)]
        if ids != expected:
            errs.append(f"README.md: index rows under {g} are [{', '.join(ids)}], expected [{', '.join(expected)}]")
        for i, target, area_word, symptom in rows:
            if target != f"{g}#{i.lower()}":
                if not (d / target.split("#")[0]).is_file():
                    errs.append(f"README.md: {i} index row is a link to missing file '{target}' "
                                "(links are relative to the README)")
                else:
                    errs.append(f"README.md: {i} index row links to '{target}', expected '{g}#{i.lower()}'")
            if not area_word:
                errs.append(f"README.md: {i} index row has an empty area cell")
            if i in sym and sym[i] != symptom:
                errs.append(f"{i}: symptom differs between {g} and README.md index\n"
                            f"    {g}: {sym[i]}\n    README: {symptom}")

    # --- retired IDs
    for r in rd.retired:
        if r in live:
            errs.append(f"{r}: listed as retired but still defined in {live[r]}")
    if rd.retired:
        pat = re.compile(r"(?<![A-Za-z0-9-])(" + "|".join(map(re.escape, rd.retired)) + r")(?!\d)")
        scan = {"README.md": rd.text.replace(rd.retired_text, "")}
        scan.update({a.name: a.text for a in areas})
        oq = d / "open-questions.md"
        if oq.is_file():
            scan[oq.name] = read(oq)
        for name, text in scan.items():
            for m in sorted(set(pat.findall(text))):
                errs.append(f"{name}: cites retired {m} (now {rd.retired[m]})")

    # --- links inside the registry
    anchors = {a.name: {h.lower() for h in a.headings} for a in areas}
    files_to_scan = [(a.name, a.text) for a in areas] + [("README.md", rd.text)]
    if (d / "open-questions.md").is_file():
        files_to_scan.append(("open-questions.md", read(d / "open-questions.md")))
    for name, text in files_to_scan:
        for target, anchor in LINK.findall(text):
            if target.startswith(("http:", "https:", "mailto:")) or "/" in target:
                continue
            tfile = target or name
            if target and not (d / target).is_file():
                errs.append(f"{name}: link to missing file {target}")
                continue
            if anchor and ANCHOR_ID.match(anchor) and tfile in anchors and anchor not in anchors[tfile]:
                errs.append(f"{name}: link to {tfile}#{anchor}, which has no such entry")

    # --- unfinished bootstrap
    for name, text in files_to_scan:
        if "<!-- FILL:" in text:
            errs.append(f"{name}: still has '<!-- FILL: ... -->' placeholders from the template")

    # de-duplicate, keep order
    seen, out = set(), []
    for e in errs:
        if e not in seen:
            seen.add(e)
            out.append(e)
    return out


def highest(d: Path) -> dict[str, int]:
    rd, areas = load(d)
    n: dict[str, int] = {}
    for i in [h for a in areas for h in a.headings if ID_FULL.match(h)] + list(rd.retired):
        p, k = id_key(i)
        n[p] = max(n.get(p, 0), k)
    return n


# ---------------------------------------------------------------- init

HOOK = {"hooks": {"PostToolUse": [{"matcher": "Edit|MultiEdit|Write",
                                   "hooks": [{"type": "command",
                                              "command": "python tools/check_gotchas.py --hook"}]}]}}


def init(dir_arg: str | None) -> int:
    assets = Path(__file__).resolve().parent.parent / "assets"
    if not assets.is_dir():
        print("init needs the skill's own copy of this script (the one next to assets/).", file=sys.stderr)
        return 1
    d = Path(dir_arg) if dir_arg else DEFAULT_DIR
    d.mkdir(parents=True, exist_ok=True)
    made = []
    for src, dst in (("README.template.md", "README.md"), ("open-questions.template.md", "open-questions.md")):
        if not (d / dst).exists():
            shutil.copyfile(assets / src, d / dst)
            made.append(str(d / dst))
    tool = Path("tools/check_gotchas.py")
    if not tool.exists():
        tool.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(__file__).resolve(), tool)
        made.append(str(tool))
    print("created: " + (", ".join(made) if made else "nothing (already present)"))
    print("next: fill every '<!-- FILL: ... -->' in README.md, then run `python tools/check_gotchas.py`.")
    print("hook (merge into .claude/settings.json if the user agrees):")
    print(json.dumps(HOOK, indent=2))
    return 0


# ---------------------------------------------------------------- main

def main(argv: list[str]) -> int:
    dir_arg = None
    if "--dir" in argv:
        i = argv.index("--dir")
        dir_arg = argv[i + 1]
        del argv[i:i + 2]

    if argv[:1] == ["init"]:
        return init(dir_arg)

    hook = "--hook" in argv
    if hook:
        try:
            event = json.load(sys.stdin)
        except Exception:
            event = {}
        path = str((event.get("tool_input") or {}).get("file_path", ""))
        if not path.endswith(".md"):
            return 0

    d = find_dir(dir_arg)
    if d is None:
        if hook:
            return 0  # project has no registry; nothing to police
        print("no docs/gotchas/README.md found (run `init` from the skill, or pass --dir)", file=sys.stderr)
        return 1

    if argv[:1] == ["ids"]:
        for p, n in sorted(highest(d).items()):
            print(f"{p}-{n}")
        return 0
    if argv[:1] == ["next"]:
        if len(argv) < 2 or not re.fullmatch(r"[A-Z][A-Z0-9]*", argv[1]):
            print("usage: check_gotchas.py next PREFIX", file=sys.stderr)
            return 1
        print(f"{argv[1]}-{highest(d).get(argv[1], 0) + 1}")
        return 0

    errs = check(d)
    if not errs:
        if not hook:
            print("OK")
        return 0
    stream = sys.stderr if hook else sys.stdout
    print(f"gotchas: {len(errs)} problem(s) in {d}", file=stream)
    for e in errs:
        print("  - " + e, file=stream)
    return 2 if hook else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
