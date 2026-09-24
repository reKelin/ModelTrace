"""Render the Pages entry point using the same API form as Flask."""
from pathlib import Path
import argparse
from hashlib import sha256

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

ROOT = Path(__file__).resolve().parents[1]


def render() -> str:
    environment = Environment(
        loader=FileSystemLoader(ROOT / "templates"),
        autoescape=select_autoescape(["html"]),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
    )
    # Normalize line endings so Windows and Linux builds use the same cache key.
    script = (ROOT / "static" / "pages-app.js").read_text(encoding="utf-8")
    script_version = sha256(script.encode("utf-8")).hexdigest()[:16]
    rendered = environment.get_template("pages.html").render(
        static_mode=True, script_version=script_version
    )
    return "\n".join(line.rstrip() for line in rendered.splitlines()) + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the committed page is stale")
    arguments = parser.parse_args()
    target = ROOT / "static" / "index.html"
    content = render()
    if arguments.check:
        if not target.exists() or target.read_text(encoding="utf-8") != content:
            parser.exit(1, "static/index.html is stale; run python tools/build_pages.py\n")
        print("Pages template is up to date")
    else:
        target.write_text(content, encoding="utf-8", newline="\n")
