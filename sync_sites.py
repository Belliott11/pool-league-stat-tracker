"""Copies the dashboard's shared files to the viewer and mail folders, then checks all three
sites so a broken page can't get pushed. Run it after every change, before committing:

    python sync_sites.py            copy, then check
    python sync_sites.py --check    check only, copy nothing

Copied: app.js, style.css, theme.css and poolean-external-data.js to the viewer; those plus
index.html to the mail folder (app.js goes there as app.js.txt). The viewer's index.html is its
own adapted page and is never overwritten.

Checks (any failure exits 1):
  - app.js parses (node --check)
  - every index.html has balanced tags and no duplicate ids
  - every element app.js grabs without a null check (document.getElementById("x").something)
    exists in each page, unless app.js creates it itself; a missing one crashes the page on load
  - no em dash in sentences the user can read, in the HTML or in app.js strings
"""
import argparse
import re
import shutil
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).parent
VIEWER = HERE.parent / "dashboard-viewer"
MAIL = HERE.parent / "dashboard-mail"
SHARED = ["app.js", "style.css", "theme.css", "poolean-external-data.js"]
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


def sync():
    for name in SHARED:
        shutil.copyfile(HERE / name, VIEWER / name)
    for name in SHARED[1:] + ["index.html"]:
        shutil.copyfile(HERE / name, MAIL / name)
    shutil.copyfile(HERE / "app.js", MAIL / "app.js.txt")
    print(f"Copied {', '.join(SHARED)} to the viewer, and those plus index.html to the mail folder.")


class TagChecker(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.errors = [], []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()
        else:
            open_tag = self.stack[-1] if self.stack else None
            self.errors.append(f"line {self.getpos()[0]}: </{tag}> closes {f'<{open_tag[0]}> from line {open_tag[1]}' if open_tag else 'nothing'}")


def visible_html(html):
    html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    return re.sub(r"<(script|style)\b.*?</\1>", "", html, flags=re.S)


def check():
    problems = []
    js = (HERE / "app.js").read_text(encoding="utf-8")

    if shutil.which("node"):
        result = subprocess.run(["node", "--check", str(HERE / "app.js")], capture_output=True, text=True)
        if result.returncode != 0:
            problems.append(f"app.js doesn't parse:\n{result.stderr.strip()}")
    else:
        print("(node isn't installed, so app.js wasn't syntax-checked)")

    unguarded = set(re.findall(r'document\.getElementById\("([\w-]+)"\)\.(?!\?)', js))
    created = set(re.findall(r'\.id = "([\w-]+)"', js)) | set(re.findall(r'id="([\w-]+)"', js))

    for page in [HERE / "index.html", VIEWER / "index.html", MAIL / "index.html"]:
        label = f"{page.parent.name}/index.html"
        html = page.read_text(encoding="utf-8")
        tags = TagChecker()
        tags.feed(html)
        problems += [f"{label}: {e}" for e in tags.errors[:5]]
        if tags.stack:
            problems.append(f"{label}: never closed: " + ", ".join(f"<{t}> from line {n}" for t, n in tags.stack[-5:]))
        ids = re.findall(r'id="([^"]+)"', html)
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            problems.append(f"{label}: duplicate ids: {', '.join(dupes)}")
        missing = sorted(unguarded - set(ids) - created)
        if missing:
            problems.append(f"{label}: app.js uses these without a null check, but the page doesn't have them: {', '.join(missing)}")
        text = visible_html(html)
        for m in re.finditer("—", text):
            problems.append(f"{label}: em dash in visible text: ...{text[max(0, m.start() - 50):m.end() + 30].strip()}...")

    for n, line in enumerate(js.split("\n"), 1):
        stripped = line.strip()
        if stripped.startswith(("//", "*", "/*")):
            continue
        code = re.sub(r"\s//\s.*$", "", line)
        if " — " in code:  # a lone "—" is an empty-cell placeholder; " — " is a sentence
            problems.append(f"app.js line {n}: em dash in a sentence: {stripped[:100]}")

    if problems:
        print("Problems found:\n  " + "\n  ".join(problems))
        return False
    print("All checks passed: app.js parses; all three pages are well-formed with every element the code needs, and no em dashes.")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="only run the checks, copy nothing")
    args = ap.parse_args()
    if not args.check:
        sync()
    sys.exit(0 if check() else 1)


if __name__ == "__main__":
    main()
