#!/usr/bin/env python3
"""Bundle complete catalog indexes for the static site. Maintainer tool only.

Requires an installed yt-dlp executable; visitors need only their browser.
Run again to resume. Use --refresh to replace successful snapshots explicitly.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

from daily_video import collect_videos, normalize_source, read_index
from video_metadata import video_summary, public_metadata

ROOT = Path(__file__).resolve().parents[1]


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as out:
            temporary = Path(out.name)
            out.write(text)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def javascript_json(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).replace("<", "\\u003c")


def validate_index(data, source_url):
    # Match the browser's supported limits before publishing a snapshot.
    if data.get("version") != 1 or data.get("source_url") != source_url:
        raise ValueError("Index source does not match the requested source")
    if data.get("source_type") not in {"channel", "playlist"} or not isinstance(data.get("source_title"), str) or not data["source_title"].strip():
        raise ValueError("Invalid index metadata")
    datetime.fromisoformat(data["fetched_at"].replace("Z", "+00:00"))
    videos = data.get("videos")
    if not isinstance(videos, list) or not 0 < len(videos) <= 100000:
        raise ValueError("Index must contain between 1 and 100,000 videos")
    for video in videos:
        if not isinstance(video, dict) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video.get("id", "")) or not isinstance(video.get("title"), str):
            raise ValueError("Invalid video in index")
    ids = [video["id"] for video in videos]
    if ids != sorted(set(ids)):
        raise ValueError("Video IDs must be sorted and unique")
    if len(json.dumps(data).encode("utf-8")) > 50 * 1024 * 1024:
        raise ValueError("Index exceeds the browser's 50 MB import limit")
    return data


def listing_warnings(stderr):
    """Ignore only known advisories; retain all warnings for the saved record."""
    plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", stderr)
    messages = re.findall(r"(?m)^[ \t]*WARNING:[ \t]*(.+)$", plain)
    blocked, hidden_counts = [], []
    for message in messages:
        if re.fullmatch(r"Your yt-dlp version \([^)]+\) is older than \d+ days!", message):
            continue
        hidden = re.fullmatch(r"\[youtube:tab\] YouTube said: INFO - (\d+) unavailable videos? (?:is|are) hidden", message)
        if hidden:
            hidden_counts.append(int(hidden[1]))
            continue
        blocked.append(message)
    # Defensive: do not trust a zero exit code accompanied by an extractor error.
    blocked.extend(re.findall(r"(?m)^[ \t]*ERROR:[ \t]*(.+)$", plain))
    return messages, blocked, max(hidden_counts, default=0)


def fetch_listing(source_url, executable, timeout):
    # Ignore personal config (cookies, downloads, playlist limits, filters, etc.).
    # Never set playlist-end: every continuation page must succeed.
    command = [executable, "--ignore-config", "--no-cache-dir", "--flat-playlist",
               "--skip-download", "--dump-single-json", "--socket-timeout", "20",
               "--retries", "2", "--extractor-retries", "2", "--sleep-requests", "1",
               "--extractor-args", "youtube:raise_incomplete_data=true", source_url]
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        # An explicitly absent playlists tab is an empty public catalog, not a network failure.
        if source_url.endswith("/playlists") and "This channel does not have a playlists tab" in result.stderr:
            return {"_type": "playlist", "entries": []}
        raise RuntimeError(result.stderr.strip()[-1800:] or f"yt-dlp exited {result.returncode}")
    # Continuation failures can exit successfully. Reject those and unknown warnings,
    # while allowing version-age notices and explicit hidden/unavailable-video notices.
    warnings, blocked, hidden_count = listing_warnings(result.stderr)
    if blocked:
        raise RuntimeError("Extraction may be incomplete; snapshot not replaced:\n" + "\n".join(blocked)[-1800:])
    info = json.loads(result.stdout)
    if not isinstance(info, dict) or info.get("_type") != "playlist" or not isinstance(info.get("entries"), list):
        raise ValueError("YouTube did not return a complete listing")
    if warnings:
        info["extraction_warnings"] = warnings
    if hidden_count:
        info["hidden_count"] = hidden_count
    return info


def extract(source_url, executable, timeout):
    info = fetch_listing(source_url, executable, timeout)
    is_playlist = "/playlist?" in source_url
    videos = collect_videos(info["entries"], channel_only=not is_playlist)
    fetched_at = now()
    entries = {entry["id"]: entry for entry in reversed(info["entries"])}
    for video in videos:
        video.update(video_summary(entries[video["id"]], fetched_at))
    data = {
        "version": 1, "source_url": source_url,
        "source_type": "playlist" if is_playlist else "channel",
        "source_title": (info.get("title") if is_playlist else info.get("channel")) or info.get("title") or source_url,
        "channel_id": info.get("channel_id"), "fetched_at": fetched_at, "videos": videos,
        "source_metadata": public_metadata(info),
        **({"extraction_warnings": info["extraction_warnings"]} if info.get("extraction_warnings") else {}),
        **({"hidden_count": info["hidden_count"]} if info.get("hidden_count") else {}),
    }
    return validate_index(data, source_url)


def bundle(root, item, data):
    """Publish both an importable JSON file and a file:// compatible script."""
    stem = root / "data/indexes" / item["id"]
    atomic_write(stem.with_suffix(".json"), json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    script = "window.DAILY_INDEXES = window.DAILY_INDEXES || {};\n"
    script += f"window.DAILY_INDEXES[{json.dumps(item['id'])}] = {javascript_json(data)};\n"
    atomic_write(stem.with_suffix(".js"), script)
    return {
        "status": "ready", "name": item["name"], "path": f"data/indexes/{item['id']}.js",
        "count": len(data["videos"]), "fetched_at": data["fetched_at"],
        "source_url": data["source_url"], "source_title": data["source_title"],
    }


def write_manifest(root, rows, errors, fatal_error=None):
    counts = dict(Counter(row["status"] for row in rows.values()))
    manifest = {"version": 1, "generated_at": now(), "total": len(rows), "counts": counts, "items": rows}
    atomic_write(root / "indexes-manifest.js", "window.DAILY_INDEX_MANIFEST = " + javascript_json(manifest) + ";\n")
    report = {**manifest, "errors": errors, "fatal_error": fatal_error}
    atomic_write(root / "data/index-build-report.json", json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return counts


def build(root=ROOT, *, refresh=False, prepare_only=False, only=None, timeout=600, delay=2,
          executable="yt-dlp", fetcher=None, preflight=None):
    catalog = json.loads((root / "data/suggestions.json").read_text())
    items = catalog["items"]
    if only and not any(item["id"] == only or item["name"].casefold() == only.casefold() for item in items):
        raise ValueError(f"No catalog source matches {only!r}")
    rows, errors, queue = {}, {}, []
    for item in items:
        identity = item["id"]
        if not re.fullmatch(r"[a-f0-9]{16}", identity) or identity in rows:
            raise ValueError("Invalid or duplicate catalog ID")
        rows[identity] = {"status": "pending", "name": item["name"]}
        if not item.get("url"):
            rows[identity]["status"] = "missing_url"
            errors[identity] = "No verified channel or playlist URL in the source catalog"
            continue
        try:
            url = normalize_source(item["url"])
        except ValueError as exc:
            rows[identity]["status"] = "failed"
            errors[identity] = str(exc)
            continue
        cached = root / "data/indexes" / f"{identity}.json"
        if cached.exists():
            try:
                data = validate_index(read_index(cached, url), url)
                rows[identity] = bundle(root, item, data)
            except (ValueError, OSError, KeyError, TypeError) as exc:
                errors[identity] = f"Invalid cached index: {exc}"
        selected = not only or identity == only or item["name"].casefold() == only.casefold()
        if selected and (refresh or rows[identity]["status"] != "ready"):
            queue.append((item, url))
    write_manifest(root, rows, errors)
    if prepare_only or not queue:
        return rows
    try:
        if fetcher is None:
            executable = shutil.which(executable)
            if not executable:
                raise RuntimeError("Install yt-dlp before generating indexes")
            fetcher = lambda url: extract(url, executable, timeout)
        if preflight:
            preflight()
        else:
            socket.getaddrinfo("www.youtube.com", 443, type=socket.SOCK_STREAM)
    except (OSError, RuntimeError) as exc:
        message = f"Index generation could not start: {exc}"
        write_manifest(root, rows, errors, fatal_error=message)
        raise RuntimeError(message) from exc
    try:
        for number, (item, url) in enumerate(queue, 1):
            identity = item["id"]
            print(f"[{number}/{len(queue)}] {item['name']}", flush=True)
            try:
                data = validate_index(fetcher(url), url)
                rows[identity] = bundle(root, item, data)
                errors.pop(identity, None)
                print(f"  saved {len(data['videos']):,} videos", flush=True)
            except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
                errors[identity] = str(exc)[-2000:]
                # A failed refresh leaves the last successful snapshot available.
                if rows[identity]["status"] != "ready":
                    rows[identity]["status"] = "failed"
                print(f"  failed: {errors[identity]}", file=sys.stderr, flush=True)
            write_manifest(root, rows, errors)
            if number < len(queue) and delay:
                time.sleep(delay)
    finally:
        write_manifest(root, rows, errors)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", choices=("full", "listing"), default="full", help="full: enrich saved indexes with video details and channel playlists (default); listing: fast listings only")
    parser.add_argument("--refresh", action="store_true", help="Refetch existing snapshots too")
    parser.add_argument("--prepare-only", action="store_true", help="Rebuild bundles and manifest from saved JSON, without network access")
    parser.add_argument("--only", help="Index one exact catalog name or ID")
    parser.add_argument("--timeout", type=int, default=600, help="Maximum seconds per source (default 600)")
    parser.add_argument("--delay", type=float, default=2, help="Seconds between sources (default 2)")
    parser.add_argument("--yt-dlp", default="yt-dlp", dest="executable")
    args = parser.parse_args()
    if args.timeout <= 0 or args.delay < 0:
        parser.error("Timeout must be positive and delay must be nonnegative")
    options = vars(args).copy()
    metadata = options.pop("metadata")
    try:
        rows = build(**options)
        if metadata == "full" and not args.prepare_only:
            from enrich_indexes import enrich_catalog
            enrich_catalog(ROOT, only=args.only, refresh=args.refresh, timeout=args.timeout,
                           delay=args.delay, executable=args.executable)
    except (RuntimeError, OSError, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nStopped. Completed sources were saved; run again to resume.", file=sys.stderr)
        return 130
    counts = Counter(row["status"] for row in rows.values())
    print(f"{counts['ready']}/{len(rows)} catalog sources ready; {counts['missing_url']} missing URLs, {counts['failed']} failed, {counts['pending']} pending.")
    print("Details: data/index-build-report.json")
    report = json.loads((ROOT / "data/index-build-report.json").read_text())
    metadata_report = ROOT / "data/metadata-build-report.json"
    metadata_errors = metadata == "full" and not args.prepare_only and metadata_report.exists() and json.loads(metadata_report.read_text()).get("errors")
    selected = [item for item in json.loads((ROOT / "data/suggestions.json").read_text())["items"] if not args.only or item["id"] == args.only or item["name"].casefold() == args.only.casefold()]
    ready = all(rows[item["id"]]["status"] == "ready" and item["id"] not in report["errors"] for item in selected)
    return 0 if args.prepare_only or (ready and not metadata_errors) else 1


if __name__ == "__main__":
    raise SystemExit(main())
