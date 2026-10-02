#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["yt-dlp"]
# ///
"""Create a channel or playlist JSON index for the static Daily web app."""

import argparse
import json
from pathlib import Path
import sys
import tempfile

from daily_video import fetch_index, normalize_source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="YouTube channel/playlist URL, @handle, or ID")
    parser.add_argument("--output", type=Path, default=Path("my-library.json"))
    args = parser.parse_args()
    try:
        source_url = normalize_source(args.source)
        print(f"Indexing {source_url} (metadata only)...", file=sys.stderr)
        data = fetch_index(source_url)
        # Fetch completely before creating/replacing the requested output.
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=args.output.parent, delete=False) as out:
                temporary = Path(out.name)
                json.dump(data, out, ensure_ascii=False, indent=2)
                out.write("\n")
            temporary.replace(args.output)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(f"Saved {len(data['videos'])} videos to {args.output}. Import that file into Daily.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
