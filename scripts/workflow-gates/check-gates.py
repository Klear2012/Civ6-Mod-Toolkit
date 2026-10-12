#!/usr/bin/env python3
"""Counted stop-rule gates for traceable-flow solo-dev runs. Stdlib only.

TablePro's fix-issue loop stays honest because counted rules bound it: a
short plan with a progress log, capped review rounds, verdicts that carry
evidence. This script ports that shape to one file with 8 subchecks, each
runnable alone so a lead pays context only for the gate in question.

Usage:
  python3 base/scripts/check-gates.py [--root DIR] [--change NAME]
      [--exclude PREFIX ...] [--changed-from FILE] [--receipt PATH]
      [subcheck ...]

  --receipt writes the verdict lines plus the summary counts line to PATH,
  even on FAIL (TablePro verify.sh emit(): the receipt beside the log is
  the verdict; re-reading the receipt replays it, never re-derives it).

Subchecks (default: all, in this order):
  line-cap       plan (`.analysis/<slug>/plan.md`, else the change tasks.md)
                 is 80 lines or fewer and carries a progress log
  rounds         findings.md rounds: review 3 or fewer, CI-fix 2 or fewer,
                 report section 8 lines or fewer
  left-open      every Left-open item carries file:line evidence
  ownership      every changed file sits inside the change declared scope
  banned-words   added lines avoid base/banned-words.txt terms
  stale-refs     agent docs name no retired artifact, schema, or command;
                 backticked base//packs/ paths exist, Skill(name) refs
                 resolve under .opencode/skills/, cited .sh files exist
                 and are executable. Long CamelCase names must resolve as
                 code identifiers in non-comment source (short/upper words
                 are prose, unchecked); gitignored paths are optional by
                 design; stated "The/All N <noun>" counts FAIL unless the
                 line carries its source. TBD/TODO/FIXME/XXX in
                 openspec/specs/ FAILs; in docs/ WARNs. Fenced examples,
                 inline code spans, placeholders, and absolute paths are
                 not claims and are skipped. Only Skill(name) and $cmd
                 spellings are resolve-checked; prose skill names are out
                 of scope. packs/*/pack.md files are candidates;
                 templates/, WORKFLOW.md, and packs/other/ stay out by
                 policy (inert starters, design history, and parked notes
                 ship no live agent rules). Consumer layout (no base/
                 dir): the project AGENTS.md plus openspec/config.yaml
                 are read read-only instead; SKIP only with neither file.
  doctor         `openspec doctor` exits 0 with no red markers
  archive-ready  `openspec validate <name> --type change` passes and tasks.md
                 checkboxes parse (all ticked implies findings.md exists).
                 FAIL details are copy-paste fix commands; a FAIL also
                 prints a BLOCKERS section (exit 1 blocks archive regardless
                 of section).

PLANNED (debt only, not implemented - no subcheck below reads it):
  size-triggers    past 500 lines touched the lead owes a review pass;
                   past 1000 a diagnose pass turns mandatory. A future
                   subcheck reads the diff stat and fails the run when
                   the pass is missing.
  delta-budget     about 300 lines per change; past that the plan must
                   carry a justify-or-split line. A future subcheck
                   fails the run when the line is missing.
  links            dead internal links plus anchors in docs pages. A
                   future subcheck walks docs links (prior art: TablePro
                   check-links.py) and fails the run on dead ones.

GROWTH (policy, confirmed 2026-10-11 against TablePro scripts/ci, where one
scar owns one small tested guard): this file takes no new subchecks. Each
future scar gets its own script with its own fixtures, never a branch below.
Where the shared linter is blind, the blind spot gets its own guard
(precedent: a hygiene workflow beside the main lint, one check per class).

Each subcheck prints one line: PASS / FAIL / SKIP / WARN plus detail,
then a summary counts line. Exit 0 when nothing FAILs, 1 on any FAIL,
2 on usage error. A missing optional input SKIPs (legacy changes predate
some files); only archive-ready is a hard gate, and only for changes cut
after this script landed. Cite TablePro sources by skill file and phase,
never by dot-dir path.
"""

import argparse
import os
import re
import subprocess
import sys

CAP_PLAN_LINES = 80
CAP_REVIEW_ROUNDS = 3
CAP_CIFIX_ROUNDS = 2
CAP_REPORT_LINES = 8

FILE_LINE = re.compile(r"[A-Za-z0-9_./~$-]+\.[A-Za-z0-9]+:\d+")
LEFT_OPEN = re.compile(r"(?:^|[\s*\-])LEFT-OPEN\s*:|Left open\s*:")
PLACEHOLDER = re.compile(r"<[^<>\n]+>")
CHECKBOX = re.compile(r"^(\s*-\s*\[)([^\]]*)(\])")
TBD = re.compile(r"\b(TBD|TODO|FIXME|XXX)\b")
# Known miss: plurals (TODOs) never match; inline `code` spans are stripped
# before matching, so a marker shown as formatting stays out of scope.
IDENT = re.compile(r"`([A-Z][A-Za-z0-9_]{7,})`")
COUNT_CLAIM = re.compile(r"\b(The|All)\s+(\d+)\s+([A-Za-z][A-Za-z-]*)")
# Known miss: lowercase counts (all 3 widgets) never match; only The/All.
CODE_EXTS = (".py", ".js", ".ts", ".sh")
VALID_BOX = re.compile(r"^\s*-\s*\[[ \t]*[xX][ \t]*\]")
WS_LINE = re.compile(r"^\s*$")


class Result:
    def __init__(self, name, status, detail):
        self.name = name
        self.status = status  # PASS FAIL SKIP WARN
        self.detail = detail

    def __str__(self):
        return "%s: %s - %s" % (self.status, self.name, self.detail)


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def change_dir(root, change):
    return os.path.join(root, "openspec", "changes", change)


def detect_change(root):
    base = os.path.join(root, "openspec", "changes")
    names = sorted(
        d
        for d in os.listdir(base)
        if d != "archive"
        and os.path.isfile(os.path.join(base, d, ".openspec.yaml"))
    )
    if len(names) == 1:
        return names[0]
    raise SystemExit(
        "usage error: --change required (%s)" % (", ".join(names) or "no changes")
    )


def run(cmd, cwd):
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=120
        )
    except FileNotFoundError:
        if os.name == "nt":
            try:
                proc = subprocess.run(
                    subprocess.list2cmdline(cmd), cwd=cwd,
                    capture_output=True, text=True, timeout=120, shell=True,
                )
            except OSError:
                return None, "", "%s: not on PATH" % cmd[0]
        else:
            return None, "", "%s: not on PATH" % cmd[0]
    return proc.returncode, proc.stdout + proc.stderr, ""


def sub_line_cap(root, change, _opts):
    slug = change.replace("/", "-")
    local_plan = os.path.join(root, ".analysis", slug, "plan.md")
    if os.path.isfile(local_plan):
        plan, kind = local_plan, "plan.md"
    else:
        plan = os.path.join(change_dir(root, change), "tasks.md")
        kind = "tasks.md"
    if not os.path.isfile(plan):
        return Result("line-cap", "SKIP", "no %s yet" % kind)
    lines = read_text(plan).splitlines()
    if len(lines) > CAP_PLAN_LINES:
        return Result(
            "line-cap", "FAIL",
            "%s has %d lines, cap is %d" % (kind, len(lines), CAP_PLAN_LINES),
        )
    if kind == "plan.md":
        head = lines[:15]
        if not any(re.match(r"^#{1,4}\s*progress\b", ln, re.IGNORECASE) for ln in head):
            return Result("line-cap", "FAIL", "plan.md opens with no progress log")
    else:
        if not any(VALID_BOX.match(ln) for ln in lines):
            return Result("line-cap", "FAIL", "tasks.md carries no checkboxes")
    return Result(
        "line-cap", "PASS",
        "%s %d lines with progress tracking" % (kind, len(lines)),
    )


def sub_rounds(root, change, _opts):
    path = os.path.join(change_dir(root, change), "findings.md")
    if not os.path.isfile(path):
        return Result("rounds", "SKIP", "no findings.md yet")
    text = read_text(path)
    if "no bugfix rounds" in text.lower():
        return Result("rounds", "PASS", "no bugfix rounds required")
    blocks = re.split(r"^###\s+Round\b", text, flags=re.IGNORECASE | re.MULTILINE)
    rounds = blocks[1:]
    if len(rounds) > CAP_REVIEW_ROUNDS:
        return Result(
            "rounds", "FAIL",
            "%d review rounds, cap is %d" % (len(rounds), CAP_REVIEW_ROUNDS),
        )
    cifix = [b for b in rounds if re.search(r"\bci\b", b, re.IGNORECASE)]
    if len(cifix) > CAP_CIFIX_ROUNDS:
        return Result(
            "rounds", "FAIL",
            "%d CI-fix rounds, cap is %d" % (len(cifix), CAP_CIFIX_ROUNDS),
        )
    mrep = re.search(
        r"^##\s+Report\b(.*?)(?=^##\s|\Z)", text,
        flags=re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    if mrep:
        nlines = [ln for ln in mrep.group(1).splitlines() if not WS_LINE.match(ln)]
        if len(nlines) > CAP_REPORT_LINES:
            return Result(
                "rounds", "FAIL",
                "report has %d lines, cap is %d" % (len(nlines), CAP_REPORT_LINES),
            )
    return Result("rounds", "PASS", "%d round(s) within caps" % len(rounds))


def sub_left_open(root, change, _opts):
    cdir = change_dir(root, change)
    scanned, bad, markers = [], [], 0
    for name in ("tasks.md", "findings.md", "verification.md"):
        path = os.path.join(cdir, name)
        if not os.path.isfile(path):
            continue
        scanned.append(name)
        for lineno, line in enumerate(read_text(path).splitlines(), 1):
            if not LEFT_OPEN.search(line):
                continue
            if re.match(r"^#{1,6}\s*(LEFT-OPEN|Left open)\s*:?\s*$", line):
                continue
            markers += 1
            if re.search(r"LEFT-OPEN:\s*none", line, re.IGNORECASE):
                continue
            if PLACEHOLDER.search(line):
                continue
            if not FILE_LINE.search(line):
                bad.append("%s:%d: %s" % (name, lineno, line.strip()[:100]))
    if bad:
        return Result(
            "left-open", "FAIL",
            "%d item(s) without file:line: %s" % (len(bad), "; ".join(bad)),
        )
    return Result(
        "left-open", "PASS",
        "checked %s, %d marker(s) all evidenced"
        % (", ".join(scanned or ["none"]), markers))


def iter_change_tokens(cdir):
    toks = []
    for name in sorted(os.listdir(cdir)):
        if not name.endswith(".md"):
            continue
        for word in re.split(r"\s+", read_text(os.path.join(cdir, name))):
            word = word.strip("`\"'(),.;:!?*[]")
            if re.search(r"\.[A-Za-z0-9]{1,10}$", word) and re.match(
                r"[A-Za-z0-9_~][\w./~-]*$", word
            ):
                toks.append(("file", word.lstrip("./")))
            elif re.match(r"[\w.~][\w./~-]+/$", word):
                toks.append(("dir", word.strip("/") + "/"))
            elif (
                "/" in word
                and re.match(r"[\w.~][\w./~-]*$", word)
                and "." not in word.split("/")[-1]
            ):
                toks.append(("dir", word.strip("/") + "/"))
    return toks


def git_status_paths(root):
    rc, out, _ = run(["git", "status", "--porcelain=v1", "-uall"], root)
    if rc != 0:
        return None
    paths = []
    for line in out.splitlines():
        entry = line[3:]
        if " -> " in entry:
            entry = entry.split(" -> ", 1)[1]
        paths.append(entry.strip('"'))
    return paths


def sub_ownership(root, change, opts):
    cdir = change_dir(root, change)
    declared = iter_change_tokens(cdir)
    if opts.changed_from:
        with open(opts.changed_from, encoding="utf-8") as fh:
            changed = [ln.strip() for ln in fh if ln.strip()]
    else:
        changed = git_status_paths(root)
        if changed is None:
            return Result("ownership", "SKIP", "not a git checkout")

    def skipped(path):
        if path.startswith((".analysis/", ".git/")):
            return True
        if any(path == ex or path.startswith(ex.rstrip("/") + "/") for ex in opts.exclude):
            return True
        # Plan-local paths count only when the change declares them (a
        # proposal that names `specs/...` owns that delta; undeclared
        # scratch under openspec/ belongs to no run).
        if path.startswith("openspec/") and not owned(path):
            return True
        return False

    def owned(path):
        for kind, tok in declared:
            if kind == "file" and path == tok:
                return True
            if kind == "dir" and path.startswith(tok):
                return True
        return False

    live = [p for p in changed if not skipped(p)]
    dropped = sorted(set(changed) - set(live))
    stray = [p for p in live if not owned(p)]
    if stray:
        return Result(
            "ownership", "FAIL",
            "diff outside declared scope: %s" % ", ".join(sorted(stray)),
        )
    detail = "%d changed file(s) inside scope" % len(live)
    if dropped:
        detail += "; dropped %d outside scope: %s" % (
            len(dropped), ", ".join(dropped[:8]))
    return Result("ownership", "PASS", detail)


def load_terms(list_path):
    terms = []
    for line in read_text(list_path).splitlines():
        line = line.rstrip()
        if not line or line.startswith("#"):
            continue
        terms.append(line)
    return terms


def contains_term(lowered, term):
    needle = term.lower()
    anchored = needle[0].isalnum()
    start = 0
    while True:
        at = lowered.find(needle, start)
        if at < 0:
            return False
        if not anchored or at == 0 or lowered[at - 1] not in "abcdefghijklmnopqrstuvwxyz0123456789_-":
            return True
        start = at + 1


def sub_banned_words(root, _change, opts):
    list_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "banned-words.txt")
    list_path = os.path.normpath(list_path)
    if not os.path.isfile(list_path):
        return Result("banned-words", "SKIP", "no banned-words.txt")
    terms = load_terms(list_path)
    # Default target mirrors the staged-lines check: added lines of tracked
    # diffs. Stage explicit paths first, then run; new untracked files join
    # via --files until they are staged.
    targets = []
    unreadable = []
    if not opts.no_diff:
        for args in (["git", "diff", "-U0"], ["git", "diff", "--cached", "-U0"]):
            rc, out, _ = run(args, root)
            if rc is None:
                continue
            fname, lineno = None, 0
            for line in out.splitlines():
                if line.startswith("+++ "):
                    fname = line[4:].strip().strip('"')
                    if fname.startswith("b/"):
                        fname = fname[2:]
                elif line.startswith("@@ "):
                    m = re.search(r"\+(\d+)", line)
                    lineno = int(m.group(1)) if m else 0
                elif line.startswith("+") and not line.startswith("+++"):
                    if fname and fname != os.path.relpath(list_path, root).replace(os.sep, "/"):
                        targets.append((fname, (lineno, line[1:])))
                    lineno += 1
                elif not line.startswith("-"):
                    if line.startswith(" "):
                        lineno += 1
    for extra in opts.files or []:
        if os.path.abspath(extra) != os.path.abspath(list_path):
            targets.append((extra, None))
    hits = []
    for fname, inline in targets:
        if inline is not None:
            lineno, text = inline
            for term in terms:
                if contains_term(text.lower(), term):
                    hits.append("%s:%d: %s" % (fname, lineno, term))
            continue
        fpath = fname if os.path.isabs(fname) else os.path.join(root, fname)
        if not os.path.isfile(fpath):
            unreadable.append(fname)
            continue
        try:
            with open(fpath, "rb") as fh:
                head = fh.read(8192)
            if b"\0" in head:
                unreadable.append(fname)
                continue
            content = read_text(fpath)
        except OSError:
            unreadable.append(fname)
            continue
        for lineno, text in enumerate(content.splitlines(), 1):
            for term in terms:
                if contains_term(text.lower(), term):
                    hits.append("%s:%d: %s" % (fname, lineno, term))
    if hits:
        shown = "; ".join(hits[:10])
        if len(hits) > 10:
            shown += " (+%d more)" % (len(hits) - 10)
        return Result("banned-words", "FAIL", shown)
    scanned = sorted(set(
        fname for fname, inline in targets if inline is not None))
    scanned += sorted(set(
        fname for fname, inline in targets
        if inline is None and fname not in unreadable))
    n_inline = sum(1 for _f, inl in targets if inl is not None)
    n_whole = sum(1 for _f, inl in targets if inl is None)
    detail = "no banned terms in %d added line(s)" % n_inline
    if n_whole:
        detail += " + %d whole file(s)" % n_whole
    detail += " across %d file(s)" % len(scanned)
    if unreadable:
        detail += "; skipped unreadable: %s" % ", ".join(
            sorted(set(unreadable))[:5])
    return Result("banned-words", "PASS", detail)


# LITERAL_PATTERNS match anywhere (exact substring): tool and artifact names
# that never hide inside longer innocent words. WORD_PATTERNS match
# case-insensitively with word boundaries: retired vocabulary that does hide
# inside longer words (mydecisions/ must NOT fire, Spec-Driven must).
LITERAL_PATTERNS = [
    "verify.sh",
    "xcodebuild",
    "swiftlint",
    ".claude/",
]

WORD_PATTERNS = [
    "decisions/",
    "spec-driven",
    "decision.md",
]

WORD_RES = [
    re.compile(r"(?<![A-Za-z0-9_])" + re.escape(p) + r"(?![A-Za-z0-9_])",
               re.IGNORECASE)
    for p in WORD_PATTERNS
]


SKILL_REF = re.compile(r"Skill\(([A-Za-z0-9-]+)\)|\$([a-z]+(?:-[a-z0-9]+)+)")
SCRIPT_REF = re.compile(r"(?<![\w/.-])([\w.~+-][\w./~+-]*\.sh)(?![\w])")
BACKTICK_REF = re.compile("`([^`]+)`")


def prose_lines(path):
    # TablePro check-doc-symbols.sh: strip fenced code first. A name inside
    # an example block is an example, not a claim about the tree.
    out, fence = [], False
    for lineno, line in enumerate(read_text(path).splitlines(), 1):
        if re.match(r"^\s*```", line):
            fence = not fence
            continue
        if not fence:
            out.append((lineno, line))
    return out


def backtick_path_problem(root, token):
    tok = token.strip().strip("\"'(),.;:!?*[]")
    if (
        not tok or "<" in tok or ">" in tok or "://" in tok
        or re.search(r"[\s:*|{}$'\"]", tok) or tok[0] in "-/~"
    ):
        return None  # placeholder, command, URL, flag, or home path
    if not tok.startswith("base/") and not tok.startswith("packs/"):
        return None  # only trees this workspace owns are checkable here;
        # adr/, specs/, tests/, notes/ name target repos, so plain prose
        # uses of them are vocabulary, not claims about this tree.
    if not os.path.exists(os.path.join(root, tok.rstrip("/"))):
        return "path does not exist: %s" % tok
    return None


def skill_problem(root, name):
    # No hand-kept builtin list: two lists that must agree rot silently.
    if os.path.isdir(os.path.join(root, ".opencode", "skills", name)):
        return None
    return "skill does not resolve: %s" % name


def script_problem(root, doc_dir, token):
    if "<" in token or ">" in token or "://" in token:
        return None  # placeholder or URL, not a claim about this tree
    if token.startswith(("/", "~")):
        return None  # absolute or home path, not this tree
    hit = None
    for cand in (os.path.join(root, token), os.path.join(doc_dir, token)):
        if os.path.isfile(cand):
            hit = cand
            break
    if hit is None:
        return "script does not exist: %s" % token
    if "lib" in token.split("/"):
        return None  # sourced lib, not executed (TablePro rule)
    try:
        mode = os.stat(hit).st_mode
    except OSError:
        return None
    if not mode & 0o111:
        return "script exists but is not executable: %s" % token
    return None


def gitignored(root, token):
    # TablePro check-doc-symbols.sh resolve_path: a gitignored path is
    # per-developer or downloaded, so its absence is the expected state.
    # Optional by design; a missing git binary fails closed (not optional).
    if not os.path.isdir(os.path.join(root, ".git")):
        return False
    rc, _, _ = run(["git", "check-ignore", "-q", "--", token], root)
    return rc == 0


def code_identifiers(root):
    # TablePro check-doc-symbols.sh uncommented_identifiers: a name that
    # survives only in somebody's comment does not count as resolved.
    # String literals stay (a name used in a literal is still used).
    # Only full-line comments and /* */ blocks are stripped: cheap,
    # documented, and openly incomplete for trailing comments.
    found = set()
    for dirpath, _names, filenames in os.walk(root):
        if ".git" in dirpath.split(os.sep):
            continue
        for fn in filenames:
            if not fn.endswith(CODE_EXTS):
                continue
            try:
                text = read_text(os.path.join(dirpath, fn))
            except OSError:
                continue
            text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
            for line in text.splitlines():
                s = line.strip()
                if s.startswith("#") or s.startswith("//"):
                    continue
                for tok in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", line):
                    found.add(tok)
    return found


def identifier_problem(idents, token):
    # Long mixed-case words are symbol claims; short/upper words are prose
    # (PASS, WARN, Related) and stay unchecked. Stated openly: short symbol
    # names are a known miss, not a silent one.
    if not re.search(r"[a-z]", token):
        return None
    if token in idents:
        return None
    return "identifier does not resolve in code: %s" % token


def sub_stale_refs(root, _change, _opts):
    candidates = []
    base_agents = os.path.join(root, "base", "AGENTS.md")
    if os.path.isfile(base_agents):
        candidates.append(base_agents)
        for pack in sorted(
            p for p in glob_pack_dirs(root) if os.path.isfile(doc_path(root, p))
        ):
            candidates.append(doc_path(root, pack))
        for pack_dir in sorted(glob_pack_dirs(root)):
            pack_file = os.path.join(pack_dir, "pack.md")
            if os.path.isfile(pack_file):
                candidates.append(pack_file)
        for extra in ("nested-agents.md", "lanes.md", "execution-discipline.md",
                      "setup-checklist.md", "schema-notes.md"):
            path = os.path.join(root, "base", extra)
            if os.path.isfile(path):
                candidates.append(path)
    else:
        # Consumer layout: no base/ tree, so the project's own agent doc
        # plus its config rules are the candidates, read-only and never
        # written; with neither file there is no agent doc to scan.
        for path in (os.path.join(root, "AGENTS.md"),
                     os.path.join(root, "openspec", "config.yaml")):
            if os.path.isfile(path):
                candidates.append(path)
    if not candidates:
        return Result("stale-refs", "SKIP", "no agent doc to scan")
    bad, missing = [], []
    idents = None
    for path in candidates:
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        seen_here = set()
        # Fenced blocks are examples, not claims, so the retired-vocab loop
        # reads prose_lines too: history shown in a fence must not fail the run.
        for lineno, line in prose_lines(path):
            for pat in LITERAL_PATTERNS:
                if pat in line:
                    bad.append("%s:%d: %s" % (rel, lineno, pat))
            for pat_rx, pat in zip(WORD_RES, WORD_PATTERNS):
                if pat_rx.search(line):
                    bad.append("%s:%d: %s" % (rel, lineno, pat))
            for tok in re.findall(r"(?:base|packs)/\S+", line):
                clean = tok.strip("`\"'(),.;:!?*[]")
                if clean.endswith("/"):
                    full = os.path.join(root, clean)
                    if not os.path.isdir(full):
                        if gitignored(root, clean):
                            continue  # optional by design, not a claim
                        missing.append("%s:%d: %s" % (rel, lineno, clean))
                        seen_here.add((lineno, clean))
                elif "." in clean.split("/")[-1]:
                    if not os.path.isfile(os.path.join(root, clean)):
                        if gitignored(root, clean):
                            continue  # optional by design, not a claim
                        missing.append("%s:%d: %s" % (rel, lineno, clean))
                        seen_here.add((lineno, clean))
        for lineno, line in prose_lines(path):
            for bt in BACKTICK_REF.findall(line):
                prob = backtick_path_problem(root, bt)
                key = (lineno, bt.strip().strip("`\"'(),.;:!?*[]"))
                if prob and key not in seen_here:
                    if "does not exist" in prob and gitignored(root, key[1]):
                        continue  # optional by design, not a claim
                    missing.append("%s:%d: %s" % (rel, lineno, prob))
            for match in SKILL_REF.finditer(line):
                prob = skill_problem(root, match.group(1) or match.group(2))
                if prob:
                    missing.append("%s:%d: %s" % (rel, lineno, prob))
            for stok in SCRIPT_REF.findall(line):
                prob = script_problem(root, os.path.dirname(path), stok)
                if prob and "does not exist" in prob:
                    if gitignored(root, stok):
                        prob = None  # optional by design, not a claim
                if prob:
                    missing.append("%s:%d: %s" % (rel, lineno, prob))
            for tok in IDENT.findall(line):
                if idents is None:
                    idents = code_identifiers(root)
                prob = identifier_problem(idents, tok)
                if prob:
                    missing.append("%s:%d: %s" % (rel, lineno, prob))
            for match in COUNT_CLAIM.finditer(line):
                if not FILE_LINE.search(line):
                    missing.append(
                        "%s:%d: stated count '%s' carries no source; attach "
                        "the command that reproduces it or drop the number"
                        % (rel, lineno, match.group(0)))
    problems = bad + missing
    spec_tbd, docs_todo = [], []
    for top, bucket in ((os.path.join(root, "openspec", "specs"), spec_tbd),
                        (os.path.join(root, "docs"), docs_todo)):
        if not os.path.isdir(top):
            continue
        for dirpath, _names, filenames in os.walk(top):
            for fn in sorted(filenames):
                if not fn.endswith(".md"):
                    continue
                path = os.path.join(dirpath, fn)
                rel = os.path.relpath(path, root).replace(os.sep, "/")
                for lineno, line in prose_lines(path):
                    if TBD.search(BACKTICK_REF.sub("", line)):
                        bucket.append("%s:%d: unfinished marker" % (rel, lineno))
    problems = problems + spec_tbd
    if problems:
        return Result("stale-refs", "FAIL", "; ".join(problems[:10]))
    if docs_todo:
        return Result("stale-refs", "WARN", "; ".join(docs_todo[:10]))
    return Result(
        "stale-refs", "PASS", "%d doc file(s) clean" % len(candidates)
    )


def glob_pack_dirs(root):
    packs = os.path.join(root, "packs")
    if not os.path.isdir(packs):
        return []
    return [
        os.path.join(root, "packs", d)
        for d in os.listdir(packs)
        if os.path.isdir(os.path.join(root, "packs", d)) and d != "other"
    ]


def doc_path(root, pack_dir):
    return os.path.join(pack_dir, "AGENTS.md")


RED_MARKERS = re.compile(r"(?im)^(error\b.*|.*\b(error|failed|warning)\b.*)$")


def sub_doctor(root, _change, _opts):
    rc, out, _ = run(["openspec", "doctor"], root)
    if rc is None:
        return Result("doctor", "SKIP", "openspec not on PATH")
    if rc != 0:
        return Result("doctor", "FAIL", "openspec doctor exits %d" % rc)
    red = [ln.strip() for ln in RED_MARKERS.findall(out)]
    if red:
        return Result("doctor", "FAIL", "; ".join(red[:5]))
    return Result("doctor", "PASS", "exits 0, no red markers")


def sub_archive_ready(root, change, _opts):
    rc, out, _ = run(["openspec", "validate", change, "--type", "change"], root)
    if rc is None:
        return Result("archive-ready", "SKIP", "openspec not on PATH")
    if rc != 0:
        # Fallback trigger: single-change validate red while bulk validate
        # stays green, so the task parse below still decides the verdict.
        rc2, _out2, _ = run(["openspec", "validate", "--changes"], root)
        if rc2 != 0:
            tail = "\n".join(out.splitlines()[-5:])
            return Result(
                "archive-ready", "FAIL",
                "fix: openspec validate %s --type change  # red: %s"
                % (change, tail))
    tasks = os.path.join(change_dir(root, change), "tasks.md")
    if not os.path.isfile(tasks):
        return Result("archive-ready", "FAIL", "fix: openspec instructions tasks --change %s --json  # then write tasks.md" % change)
    # Fenced `- [ ]` lines are examples, not tasks, so the count uses prose
    # lines; a real task inside a fence is a known miss, not a verdict.
    done, total = 0, 0
    for _lineno, line in prose_lines(tasks):
        if CHECKBOX.match(line):
            total += 1
            if VALID_BOX.match(line):
                done += 1
    if total == 0:
        return Result("archive-ready", "FAIL", "fix: add '- [ ] x.y ...' checkboxes to tasks.md")
    if done == total:
        findings = os.path.join(change_dir(root, change), "findings.md")
        if not os.path.isfile(findings):
            return Result(
                "archive-ready", "FAIL",
                "fix: create findings.md ('No bugfix rounds required' if none); all %d tasks ticked" % total,
            )
    return Result("archive-ready", "PASS", "tasks %d/%d done" % (done, total))


SUBCHECKS = [
    ("line-cap", sub_line_cap),
    ("rounds", sub_rounds),
    ("left-open", sub_left_open),
    ("ownership", sub_ownership),
    ("banned-words", sub_banned_words),
    ("stale-refs", sub_stale_refs),
    ("doctor", sub_doctor),
    ("archive-ready", sub_archive_ready),
]


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".",
                        help="project root (default: current directory)")
    parser.add_argument("--change", default=None,
                        help="change name (default: sole change in openspec/changes)")
    parser.add_argument("--exclude", action="append", default=[],
                        help="path prefix outside this run scope (repeatable)")
    parser.add_argument("--changed-from", default=None,
                        help="read changed paths from FILE instead of git status")
    parser.add_argument("--files", nargs="*", default=None,
                        help="banned-words: extra files to scan fully")
    parser.add_argument("--receipt", default=None, metavar="PATH",
                        help="also write verdict lines + summary to PATH")
    parser.add_argument("--no-diff", action="store_true",
                        help="banned-words: skip tracked diffs (fixtures, non-checkouts)")
    parser.add_argument("subchecks", nargs="*", default=None,
                        help="subcheck names (default: all 8)")
    opts = parser.parse_args(argv)
    root = os.path.abspath(opts.root)
    wanted = opts.subchecks or [name for name, _ in SUBCHECKS]
    unknown = [w for w in wanted if w not in [name for name, _ in SUBCHECKS]]
    if unknown:
        print("unknown subcheck(s): %s" % ", ".join(unknown), file=sys.stderr)
        return 2
    try:
        change = opts.change or detect_change(root)
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 2
    results = []
    for name, func in SUBCHECKS:
        if name in wanted:
            try:
                results.append(func(root, change, opts))
            except OSError as exc:
                results.append(Result(name, "FAIL", "io error: %s" % exc))
    lines = []
    for res in results:
        print(res)
        lines.append(str(res))
    blockers = [
        "%s: %s" % (res.name, res.detail)
        for res in results
        if res.name == "archive-ready" and res.status == "FAIL"
    ]
    if blockers:
        print("BLOCKERS (exit 1 blocks archive regardless of section):")
        lines.append("BLOCKERS (exit 1 blocks archive regardless of section):")
        for item in blockers:
            print("- %s" % item)
            lines.append("- %s" % item)
    counts = {}
    for res in results:
        counts[res.status] = counts.get(res.status, 0) + 1
    summary = ", ".join(
        "%d %s" % (counts.get(st, 0), st.lower()) for st in ("PASS", "FAIL", "SKIP", "WARN")
    )
    print("gates: %s" % summary)
    lines.append("gates: %s" % summary)
    if opts.receipt:
        try:
            with open(opts.receipt, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
        except OSError as exc:
            print("receipt unwritable: %s" % exc, file=sys.stderr)
            return 2
    return 1 if counts.get("FAIL") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))