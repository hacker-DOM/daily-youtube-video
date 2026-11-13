#!/usr/bin/env python3
"""Package the public site and lossless metadata archives from local collection files.

The site fits on GitHub Pages; full archives are served from the repository's
public archive branch. No YouTube requests are made and raw files are not changed.
"""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import re
import shutil

from build_indexes import ROOT, javascript_json, validate_index

ASSETS = (
    ".nojekyll", "index.html", "icon.svg", "styles.css", "insights.css", "core.js",
    "app.js", "insights.js", "insights-ui.js", "library.js", "suggestions-data.js",
    "suggestions.js", "bundled-indexes.js", "site-data.js",
)


def write_gzip(path, data):
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    # Check the deployed representation, including Unicode and observation histories.
    if json.loads(gzip.decompress(path.read_bytes())) != data:
        raise ValueError(f"Archive round-trip failed: {path}")
    return path.stat().st_size


def shard_key(identity):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", identity):
        raise ValueError(f"Invalid video ID: {identity}")
    # Hex preserves case on macOS filesystems (AA and Aa must have different files).
    return "".join(f"{ord(character):02x}" for character in identity[:2])


def prepare_output(path, root):
    path, root = Path(path).resolve(), Path(root).resolve()
    if path == root or root.is_relative_to(path) or path.is_relative_to(root / "data"):
        raise ValueError("Output must be separate from source and raw data")
    path.mkdir(parents=True, exist_ok=True)
    return path


def build_site(root, output, metadata_base):
    root = Path(root)
    output = prepare_output(output, root)
    if not metadata_base.startswith(("https://", "http://localhost:", "http://127.0.0.1:")):
        raise ValueError("A public HTTPS metadata URL is required")
    for name in ASSETS:
        shutil.copy2(root / name, output / name)
    config = {"metadata_base": metadata_base.rstrip("/")}
    (output / "site-config.js").write_text("window.DAILY_SITE_CONFIG = " + javascript_json(config) + ";\n")
    report = json.loads((root / "data/index-build-report.json").read_text())
    manifest = {key: value for key, value in report.items() if key not in {"errors", "fatal_error"}}
    count = 0
    for identity, entry in manifest["items"].items():
        if not re.fullmatch(r"[a-f0-9]{16}", identity):
            raise ValueError("Invalid catalog ID")
        if entry["status"] != "ready":
            continue
        data = json.loads((root / "data/indexes" / f"{identity}.json").read_text())
        validate_index(data, entry["source_url"])
        if len(data["videos"]) != entry["count"]:
            raise ValueError(f"Source changed during packaging: {identity}")
        entry["path"] = f"data/indexes/{identity}.json.gz"
        write_gzip(output / entry["path"], data)
        count += 1
        if count % 100 == 0:
            print(f"Packaged {count} source indexes", flush=True)
    (output / "indexes-manifest.js").write_text("window.DAILY_INDEX_MANIFEST = " + javascript_json(manifest) + ";\n")
    for name in ["index-build-report.json", "metadata-build-report.json", "suggestions.json", "geography-now.json"]:
        shutil.copy2(root / "data" / name, output / "data" / name)
    total = sum(p.stat().st_size for p in output.rglob("*") if p.is_file() and ".git" not in p.parts)
    if total >= 950_000_000:
        raise ValueError(f"Site is too large for GitHub Pages: {total:,} bytes")
    summary = {"packaged_at": datetime.now(timezone.utc).isoformat(), "sources": count, "site_bytes": total}
    (output / "publication.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def build_archives(root, output, workers=8):
    root = Path(root)
    output = prepare_output(output, root)
    groups = defaultdict(list)
    for path in (root / "data/metadata/videos").glob("*.json"):
        groups[shard_key(path.stem)].append(path)

    def pack_group(item):
        key, paths = item
        data = {}
        for path in sorted(paths):
            archive = json.loads(path.read_text())
            if archive.get("metadata", {}).get("id") != path.stem:
                raise ValueError(f"Video archive ID mismatch: {path}")
            data[path.stem] = archive
        return write_gzip(output / "videos" / f"{key}.json.gz", data)

    total = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for number, size in enumerate(pool.map(pack_group, sorted(groups.items())), 1):
            total += size
            if number % 256 == 0:
                print(f"Packaged {number}/{len(groups)} video archive groups ({total / 1_000_000:.1f} MB)", flush=True)
    counts = {"videos": sum(map(len, groups.values()))}
    for kind in ["channels", "playlists"]:
        paths = sorted((root / "data/metadata" / kind).glob("*.json"))
        # These complete records remain available alongside the video archives.
        total += write_gzip(output / f"{kind}.json.gz", {p.stem: json.loads(p.read_text()) for p in paths})
        counts[kind] = len(paths)
    summary = {"counts": counts, "gzip_bytes": total, "video_shards": len(groups)}
    (output / "archive-manifest.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".publish/site")
    parser.add_argument("--metadata-base", required=True)
    parser.add_argument("--archive-output", type=Path)
    args = parser.parse_args()
    print(json.dumps(build_site(ROOT, args.output, args.metadata_base)), flush=True)
    if args.archive_output:
        build_archives(ROOT, args.archive_output)


if __name__ == "__main__":
    main()
