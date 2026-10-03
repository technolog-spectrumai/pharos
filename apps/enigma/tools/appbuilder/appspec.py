"""What a builder needs to know about the app it is building.

One dataclass, read from the repo rather than hardcoded. Every field here is a
fact that already exists somewhere in the checkout — `tauri.conf.json` knows
the product name and the identifier, `package.json` knows the version — so the
builder DERIVES them instead of carrying a second copy that can drift.

That is the whole difference from enigma's builder, which fixes its app name
and identifier as module constants (`paths.APP_SLUG`, and a comment saying the
identity is "fixed to Enigma26"). Enigma is one app and can afford that. Three
office apps cannot: the moment a builder hardcodes "Sketch", the same file
copied for Primula is wrong in a way nothing checks.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AppSpec:
    """One buildable app, as the repo describes it."""

    slug: str
    """The directory under `apps/`, and the argument every script takes."""

    product_name: str
    """What the bundle is called. From tauri.conf.json."""

    identifier: str
    """The bundle identifier — what the OS files user data under. Changing it
    orphans everything the installed app has saved, which is why Morion's is
    still `com.spectrumaipl.zinnia` after the rename."""

    version: str
    """From tauri.conf.json, which is what the bundle actually carries."""

    dev_port: int
    """The Vite port. Distinct per app so all four run at once."""

    root: Path
    """The repo root."""

    @property
    def app_dir(self) -> Path:
        return self.root / "apps" / self.slug

    @property
    def tauri_conf(self) -> Path:
        return self.app_dir / "src-tauri" / "tauri.conf.json"

    @property
    def build_sh(self) -> Path:
        """The app's own build script. The builder DRIVES it rather than
        reimplementing the build: the script is what a developer runs by hand,
        and two paths to a bundle that can disagree is one too many."""
        return self.app_dir / "build.sh"

    @property
    def run_dev_sh(self) -> Path:
        return self.app_dir / "run_dev.sh"

    @property
    def dist_dir(self) -> Path:
        return self.app_dir / "dist"

    def target_root(self) -> Path:
        """Where cargo puts artefacts for this app.

        The three office apps are members of the repo-root workspace, and a
        workspace shares ONE target directory at its root — so the bundle is in
        `<repo>/target/`, not beside the crate. `build.sh` resolves this the
        same way; the two must agree or the builder reports "no bundle" for a
        build that produced one.
        """
        root_manifest = self.root / "Cargo.toml"
        if root_manifest.is_file() and "[workspace]" in root_manifest.read_text():
            return self.root / "target"
        return self.app_dir / "src-tauri" / "target"

    @property
    def bundle_dir(self) -> Path:
        return self.target_root() / "release" / "bundle"

    def debug_bundle_dir(self) -> Path:
        return self.target_root() / "debug" / "bundle"


#: The apps built from this family's builders — today Morion alone, built by
#: tools/morion_builder. Enigma is deliberately absent: it has its own builder
#: with editions, signing and Android, and folding it in here would mean either
#: losing that or forcing it on apps that have none.
#:
#: Sketch and Primula were once here too; their editors moved into Morion
#: (formerly Lazurite), which opens drawings and sheets itself, and the apps
#: were deleted — as was the Zinnia Builder that built them.
APPS = ("morion",)


def load(root: Path, slug: str) -> AppSpec:
    """Read one app's spec out of the checkout.

    Raises rather than guessing: a missing `tauri.conf.json` means the slug is
    wrong or the checkout is broken, and a builder that invented defaults would
    happily build the wrong thing.
    """
    app_dir = root / "apps" / slug
    conf_path = app_dir / "src-tauri" / "tauri.conf.json"
    if not conf_path.is_file():
        raise FileNotFoundError(f"no app '{slug}' under {root / 'apps'} ({conf_path} missing)")

    conf = json.loads(conf_path.read_text())
    dev_url = str(conf.get("build", {}).get("devUrl", ""))
    port = 0
    if ":" in dev_url:
        tail = dev_url.rsplit(":", 1)[-1].strip("/")
        port = int(tail) if tail.isdigit() else 0

    return AppSpec(
        slug=slug,
        product_name=str(conf.get("productName") or slug),
        identifier=str(conf.get("identifier") or ""),
        version=str(conf.get("version") or "0.0.0"),
        dev_port=port,
        root=root,
    )


def load_all(root: Path, slugs: tuple[str, ...] = APPS) -> list[AppSpec]:
    """Every app that is actually present. A slug whose directory is missing is
    skipped rather than fatal, so the tool still runs in a partial checkout."""
    out: list[AppSpec] = []
    for slug in slugs:
        try:
            out.append(load(root, slug))
        except FileNotFoundError:
            continue
    return out


def find_repo_root(start: Path | None = None) -> Path | None:
    """Walk up looking for the monorepo root.

    Identified by `apps/` holding an app with a `src-tauri`, plus the root
    `package.json` — enough to tell this checkout from any other directory that
    happens to contain a folder called `apps`.
    """
    here = (start or Path(__file__).resolve()).resolve()
    for candidate in (here, *here.parents):
        if (candidate / "package.json").is_file() and (candidate / "apps").is_dir():
            if any((candidate / "apps" / a / "src-tauri").is_dir() for a in APPS):
                return candidate
    return None
