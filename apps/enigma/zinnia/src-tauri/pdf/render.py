"""HTML in, PDF out — the transitional renderer, under Rust's supervision.

Ported from zenobia's ``toto.aralia.render`` (BSD-style licence, toto project)
and ``toto.memo.render_pdf``. Three things about it are the whole design and
are kept exactly:

* **Fetching is refused.** ``base_url=None`` only governs how a RELATIVE url
  resolves; an absolute ``http://…`` is fetched regardless — aralia proved that
  against a local server whose access log gained a real entry. So the fetcher
  is replaced: ``data:`` is allowed and nothing else. Every asset a document
  needs — its stylesheet, its fonts, its images — travels inside the HTML,
  which is also what makes the same file renderable anywhere.

* **The input is capped** before WeasyPrint sees it. A pathological document is
  a memory bomb in a layout engine.

* **There is no template language.** Constructing the HTML is the caller's job.
  Markdown is converted here with Python-Markdown and NO extensions, because the
  extensions are where evaluation lives — aralia's argument, unchanged.

Rust spawns this with a temp directory it owns: reads ``input.html`` (or
``input.md``), writes ``output.pdf`` beside it, and prints one JSON line to
stdout. It never chooses the final path — Rust does the atomic replace — and it
never touches anything outside that directory.
"""

from __future__ import annotations

import json
import os
import sys

MAX_INPUT_BYTES = 16 * 1024 * 1024


def refuse_fetch(url, timeout=10, ssl_context=None):
    """WeasyPrint's ``url_fetcher``: ``data:`` only, everything else refused.

    Raising is the documented way to refuse: WeasyPrint catches it, logs the
    failure, and renders without the resource. The document still comes out;
    the request never leaves this process.
    """
    if url.startswith("data:"):
        from weasyprint.urls import default_url_fetcher
        return default_url_fetcher(url, timeout=timeout, ssl_context=ssl_context)
    raise ValueError(f"refused: {url[:80]}")


def say(**fields):
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def main(argv):
    if len(argv) != 3 or argv[1] not in ("html", "markdown"):
        say(ok=False, error="usage: render.py html|markdown <workdir>")
        return 2
    kind, workdir = argv[1], argv[2]

    try:
        import weasyprint  # noqa: F401
        from weasyprint import HTML
    except Exception as exc:  # noqa: BLE001 — an ImportError OR a missing native lib
        say(ok=False, error=f"weasyprint_unavailable: {exc.__class__.__name__}: {exc}")
        return 3

    source = os.path.join(workdir, "input.md" if kind == "markdown" else "input.html")
    try:
        size = os.path.getsize(source)
    except OSError as exc:
        say(ok=False, error=f"no_input: {exc}")
        return 2
    if size > MAX_INPUT_BYTES:
        say(ok=False, error=f"too_large: {size} bytes")
        return 2

    with open(source, encoding="utf-8") as f:
        text = f.read()

    if kind == "markdown":
        try:
            import markdown
        except Exception as exc:  # noqa: BLE001
            say(ok=False, error=f"markdown_unavailable: {exc.__class__.__name__}: {exc}")
            return 3
        body = markdown.markdown(text, extensions=[])
        # The shell around a converted markdown file. Same shape as cyprian's
        # `htmldoc.page`: a whole document, not a fragment, so the result reads
        # as one anywhere it ends up.
        css_path = os.path.join(workdir, "style.css")
        css = ""
        if os.path.exists(css_path):
            with open(css_path, encoding="utf-8") as f:
                css = f.read()
        text = (
            '<!doctype html>\n<html><head><meta charset="utf-8">'
            f"<style>{css}</style></head><body>{body}</body></html>"
        )

    # WeasyPrint's own warnings, kept so a font substitution or a refused fetch
    # is visible to whoever asked — the row is the error channel, as aralia has
    # it. Collected, not streamed: Rust reads one JSON line.
    import logging
    lines: list[str] = []

    class Catch(logging.Handler):
        def emit(self, record):
            lines.append(self.format(record))

    handler = Catch()
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    for name in ("weasyprint", "weasyprint.progress"):
        lg = logging.getLogger(name)
        lg.setLevel(logging.WARNING)
        lg.addHandler(handler)

    target = os.path.join(workdir, "output.pdf")
    try:
        doc = HTML(string=text, base_url=None, url_fetcher=refuse_fetch).render()
        doc.write_pdf(target)
        pages = len(doc.pages)
    except Exception as exc:  # noqa: BLE001 — everything is reported, nothing traces
        say(ok=False, error=f"render_failed: {exc.__class__.__name__}: {exc}", log=lines)
        return 1

    say(ok=True, pages=pages, bytes=os.path.getsize(target), log=lines)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
