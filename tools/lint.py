#!/usr/bin/env python3
"""
Check this project against mistakes it has already made.

Not a general linter — there is no dependency budget for one, and a generic rule
set would drown the real signal. Every check corresponds to something that
actually shipped broken, and is written up in docs/. When a new trap costs
real time, add a check here.

    python3 tools/lint.py            # check the working tree
    python3 tools/lint.py <dir>      # check any extracted tree (used to prove
                                     # a check catches the commit that broke it)

Exits 1 if anything is flagged.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# code checks
# --------------------------------------------------------------------------

# Anything that changes appearance must go through applyVisual(), which mutates
# S.settings locally *before* repainting. patchSettings() only updates it once
# the server answers, so a repaint straight after paints the previous value.
VISUAL_KEYS = ("theme", "accent", "font_size", "density", "bubble_width")

LISTENER = re.compile(r"addEventListener\(\s*['\"](\w+)['\"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)")


def declared_params(source: str, name: str):
    """The parameter list of `name`, or None when it cannot be found."""
    for pattern in (
        rf"(?:export\s+)?(?:async\s+)?function\s+{re.escape(name)}\s*\(([^)]*)\)",
        rf"(?:const|let|var)\s+{re.escape(name)}\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>",
    ):
        found = re.search(pattern, source)
        if found:
            return found.group(1).strip()
    return None


def check_js(root: Path) -> list:
    problems = []
    paths = sorted((root / "static" / "js").glob("*.js"))
    sources = {p: p.read_text(encoding="utf-8") for p in paths}
    combined = "\n".join(sources.values())

    for path, source in sources.items():
        # A listener is called with the Event as its first argument. Hand it a
        # function that declares a parameter and the Event *becomes* that
        # parameter — a default only applies to `undefined`. This is how the Stop
        # button silently did nothing: addEventListener('click', stopGeneration)
        # meant S.runs.get(MouseEvent).
        for event, fname in LISTENER.findall(source):
            params = declared_params(combined, fname)
            if params:
                problems.append(
                    f"{path.name}: addEventListener('{event}', {fname}) — "
                    f"{fname}({params}) takes a parameter, so the Event becomes it. "
                    f"Wrap it: () => {fname}()")

        for line_no, line in enumerate(source.split("\n"), 1):
            if "applyVisual" in line:
                continue
            match = re.search(r"patchSettings\(\{\s*(\w+)", line)
            if match and match.group(1) in VISUAL_KEYS:
                problems.append(
                    f"{path.name}:{line_no}: patchSettings({{ {match.group(1)} }}) — "
                    f"use applyVisual() so the repaint sees the new value")
    return problems


def check_server(root: Path) -> list:
    problems = []
    source = (root / "server.py").read_text(encoding="utf-8")

    # Seed backfill may create settings.json, whose absence is itself part of
    # first-run detection. Checking afterwards made onboarding unreachable on
    # every fresh install in 1.2.6 and 1.2.7.
    bootstrap = re.search(
        r'if parts == \["bootstrap"\].*?(?=\n        # ----|\Z)', source, re.S)
    if not bootstrap:
        problems.append("server.py: bootstrap route not found")
    else:
        body = bootstrap.group(0)
        first = body.find("is_first_run = first_run()")
        seeded = [body.find('"personas": get_personas()'),
                  body.find('"prompts": get_prompts()')]
        if first < 0 or any(pos < 0 for pos in seeded):
            problems.append("server.py: bootstrap must read first-run state and seeded collections")
        elif first > min(seeded):
            problems.append(
                "server.py: call first_run() before get_personas()/get_prompts(); "
                "seed backfill creates settings.json and hides onboarding")

    main = source[source.find("def main()") :]
    startup = main[:main.find("server.serve_forever()")]
    if "get_personas()" in startup or "get_prompts()" in startup:
        problems.append(
            "server.py: do not seed collections during startup; seed tracking "
            "creates settings.json before bootstrap can detect a fresh install")
    return problems


# --------------------------------------------------------------------------
# documentation checks
# --------------------------------------------------------------------------
#
# README has shipped wrong six times: a stale model name, a claim that Lantern
# never sent tools that survived a whole release, the line count three times, and
# an accent count that said nine when there had been twelve for months. A prose
# rule in CONTRIBUTING.md did not stop any of it, because a prose rule only works
# someone chooses to look. These fail loudly instead.
#
# The pattern is *countable things* — "N of X" in prose, with the real N in the
# code. Every check below is one of those.

COUNT_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
               "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
               "twelve": 12}

def server_literal(root: Path, name: str):
    """Pull a literal assignment out of server.py without importing it."""
    tree = ast.parse((root / "server.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == name for t in node.targets):
            try:
                return ast.literal_eval(node.value)
            except ValueError:
                return None
    return None


def registered_tools(root: Path) -> list:
    """Top-level keys of the TOOLS registry, by position in the file."""
    source = (root / "server.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "TOOLS" for t in node.targets):
            return [k.value for k in node.value.keys if isinstance(k, ast.Constant)]
    return []


def theme_palette(root: Path):
    """
    What `theme.js` actually declares: accent count, theme labels, dark/light
    split. Regex rather than a parser because there is no JS parser in the
    stdlib, and these two arrays are hand-written literals that have never been
    anything more complicated.
    """
    path = root / "static" / "js" / "theme.js"
    if not path.is_file():
        return None
    source = path.read_text(encoding="utf-8")
    accents = re.search(r"ACCENTS\s*=\s*\[(.*?)\]", source, re.S)
    themes = re.search(r"THEMES\s*=\s*\[(.*?)\n\];", source, re.S)
    if not accents or not themes:
        return None
    flags = re.findall(r"dark:\s*(true|false)", themes.group(1))
    return {
        "accents": len(re.findall(r"['\"]([\w-]+)['\"]", accents.group(1))),
        "labels": re.findall(r"label:\s*['\"]([^'\"]+)['\"]", themes.group(1)),
        "dark": flags.count("true"),
        "light": flags.count("false"),
    }


def check_docs(root: Path) -> list:
    problems = []
    readme_path = root / "README.md"
    if not readme_path.is_file():
        return ["README.md is missing"]
    readme = readme_path.read_text(encoding="utf-8")

    # 1. Every registered tool must be named in the README. There used to be a
    #    second half checking the count word beside "ship" — README claimed one
    #    tool for a whole release after there were two — but counts are banned
    #    outright by rule 3 now, so it could only ever have matched a sentence
    #    that is itself a failure. Presence is the part a reader needs anyway.
    tools = registered_tools(root)
    for name in tools:
        if name not in readme:
            problems.append(f"README.md: tool `{name}` is registered in server.py "
                            f"but never mentioned")

    # 2. A default quoted in prose must equal the real default. num_ctx had five
    #    stale references when it changed from 8192.
    params = (server_literal(root, "DEFAULT_SETTINGS") or {}).get("default_params", {})
    num_ctx = params.get("num_ctx")
    if num_ctx:
        for rel in ("README.md", "static/js/modals.js"):
            target = root / rel
            if not target.is_file():
                continue
            text = target.read_text(encoding="utf-8")
            quoted = set(re.findall(r"default (\d{4,6})", text))
            quoted |= set(re.findall(r"(\d{4,6}) default", text))
            for value in quoted:
                if int(value) != num_ctx:
                    problems.append(f"{rel}: quotes a default of {value}, but "
                                    f"num_ctx is {num_ctx}")

    # 3. THE README NAMES THINGS; IT NEVER COUNTS THEM.
    #
    #    Six doc failures, and every one was a number restating something the
    #    code already enumerates: a tool count, an accent count, the line count
    #    three times. Checking each count against its source worked, but only
    #    for the ones someone thought to check, and the line count still escaped
    #    by being reworded into a shape the check could not see.
    #
    #    So the rule inverted. The counts are gone from the README — the list is
    #    the count — and this fails if one comes back. A number that is never
    #    written cannot go stale, and unlike a value check this cannot be
    #    defeated by rephrasing, because it is the *number* that is banned and
    #    not one spelling of the sentence around it.
    #
    #    Specs a reader acts on are deliberately not covered: the port, num_ctx,
    #    macOS 11, keyboard keys. Those are not "how many X" claims, and the
    #    ones that matter are checked against the code by rule 2.
    counted = "|".join(COUNT_WORDS) + r"|\d+"
    banned = (
        (rf"\b(?:{counted})\s+(accents?|themes?|tools?|personas?|prompts?)\b",
         "counts something the README also lists — name them instead"),
        (rf"\b(?:under|about|around|~)\s*[\d,]{{3,7}}\s+lines\b",
         "states a line count, which has gone stale three times"),
        (rf"\b(?:{counted})\s+(?:ship|ships)\b",
         "counts what ships — the list beside it is the count"),
    )
    for pattern, why in banned:
        for hit in re.finditer(pattern, readme, re.I):
            problems.append(f"README.md: \"{hit.group(0).strip()}\" {why}. "
                            f"See 'countable things' in CONTRIBUTING.md")

    # The interface says these things too, and its copy goes stale the same way:
    # Settings called the palette "Four dark, two light" while there were six and
    # three. Scoped to the palette nouns rather than the README's full list —
    # applying all of them flagged "comparing two prompts" in the seed help,
    # which is prose about a workflow, not a count. A check that cries wolf gets
    # ignored, which is worse than no check.
    settings_ui = root / "static" / "js" / "modals.js"
    if settings_ui.is_file():
        text = settings_ui.read_text(encoding="utf-8")
        for hit in re.finditer(rf"\b(?:{counted})\s+(accents?|themes?|dark|light)\b",
                               text, re.I):
            problems.append(f"modals.js: \"{hit.group(0).strip()}\" counts part of "
                            f"the palette in interface copy, which goes stale. "
                            f"Describe it instead")

    # 4. Every internal doc link must resolve. Two docs were deleted this
    #    session and nothing but a manual grep checked for danglers.
    for path in sorted(root.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        for target in re.findall(r"\]\(([^)#]+\.md)\)", text):
            if not (root / target).is_file():
                problems.append(f"{path.name}: links to {target}, which does not exist")

    # 5. Names, on the other hand, are exactly what the README *should* carry,
    #    so they are checked for presence rather than banned. A renamed theme is
    #    the same class of drift as a renamed tool, and naming is the thing the
    #    reader actually wants.
    palette = theme_palette(root)
    if palette:
        for label in palette["labels"]:
            if label not in readme:
                problems.append(f"README.md: theme \"{label}\" is declared in "
                                f"theme.js but never named")

    # 6. A tracked source file nobody documented. Basenames only — the Layout
    #    block is an indented tree, not full paths.
    #
    #    This check went silent once and took a new file with it: the pattern
    #    required the fence to sit immediately under the heading, and a rewrite
    #    put a sentence in between. Same disease as the line count — a check
    #    matching one shape, edited around by accident. So the fence is now found
    #    anywhere in the section, and **not finding it is itself a failure**.
    #    Silence is the one outcome a check must never have.
    layout = re.search(r"## Layout\b.*?```\n(.*?)```", readme, re.S)
    if not layout:
        problems.append("README.md: no Layout code block found under '## Layout'. "
                        "Without it nothing checks that new source files are "
                        "documented — fix the block or delete this check")
    else:
        listed = layout.group(1)
        for path in sorted((root / "static" / "js").glob("*.js")):
            if path.name not in listed:
                problems.append(f"README.md: {path.name} is not in the Layout block")
        for path in sorted((root / "tools").glob("*.py")):
            if path.name not in listed:
                problems.append(f"README.md: tools/{path.name} is not in the Layout block")
    return problems


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else \
        Path(__file__).resolve().parent.parent
    problems = check_js(root) + check_server(root) + check_docs(root)

    for problem in problems:
        print(f"  {problem}")
    if problems:
        print(f"\n{len(problems)} problem(s). See docs/shipping.md.")
        return 1
    print(f"clean — code and docs consistent ({root.name})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
