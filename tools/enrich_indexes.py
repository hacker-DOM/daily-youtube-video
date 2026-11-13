#!/usr/bin/env python3
"""Add watch-page metadata and public channel playlists to existing indexes.

Each successful request is checkpointed. Run again to resume; --refresh captures
new statistics while preserving previous observations. No video downloads.
"""

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlsplit

from build_indexes import ROOT, atomic_write, bundle, fetch_listing, now, validate_index, javascript_json
from daily_video import VIDEO_ID, PLAYLIST_ID, normalize_source
from video_metadata import public_metadata, video_summary, observation


class ExtractionBlocked(RuntimeError):
    """Stop instead of repeating thousands of requests after YouTube blocks access."""


def fetch_video(url, executable, timeout):
    command = [executable, "--ignore-config", "--no-cache-dir", "--skip-download",
               "--no-playlist", "--dump-single-json", "--ignore-no-formats-error",
               "--socket-timeout", "20", "--retries", "2", "--extractor-retries", "2",
               "--sleep-requests", "1", "--extractor-args", "youtube:raise_incomplete_data=true", url]
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[-1800:] or f"yt-dlp exited {result.returncode}")
    data = json.loads(result.stdout)
    if not isinstance(data, dict) or not isinstance(data.get("id"), str) or not VIDEO_ID.fullmatch(data["id"]) or not isinstance(data.get("title"), str):
        raise ValueError("YouTube did not return video metadata")
    # Format/player warnings need not invalidate public metadata. Keep them for review.
    if result.stderr.strip():
        data["metadata_warnings"] = result.stderr.strip()[-3000:]
    return data


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def playlist_identifier(row):
    identity = row.get("id", "")
    if not isinstance(identity, str) or not PLAYLIST_ID.fullmatch(identity):
        values = parse_qs(urlsplit(row.get("url") or "").query).get("list", [])
        identity = values[0] if values else ""
    if not PLAYLIST_ID.fullmatch(identity):
        raise ValueError("Channel playlist listing contains an unexpected entry")
    return identity


class Archive:
    def __init__(self, root, *, executable="yt-dlp", timeout=600, delay=2, refresh=False, fetch=None):
        self.root, self.executable, self.timeout = Path(root), executable, timeout
        self.delay, self.refresh, self.fetch = delay, refresh, fetch
        self.started = now()

    def saved(self, kind, identity):
        return read_json(self.root / "data/metadata" / kind / f"{identity}.json")

    def get(self, kind, identity, url):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", identity):
            raise ValueError("Invalid archive identifier")
        path = self.root / "data/metadata" / kind / f"{identity}.json"
        previous = read_json(path)
        valid = (isinstance(previous, dict) and previous.get("schema_version") == 1
                 and previous.get("source_url") == url and isinstance(previous.get("metadata"), dict)
                 and isinstance(previous.get("fetched_at"), str)
                 and (kind == "channels" or previous["metadata"].get("id") == identity)
                 and (kind == "videos" or isinstance(previous.get("entries"), list)))
        if valid and kind != "videos":
            try:
                if kind == "channels":
                    for row in previous["entries"]:
                        playlist_identifier(row)
                else:
                    playlist_summary(previous, identity)
            except (ValueError, TypeError, AttributeError):
                valid = False
        if valid and (not self.refresh or previous["fetched_at"] >= self.started):
            return previous
        try:
            info = (self.fetch(url, kind) if self.fetch else
                    fetch_video(url, self.executable, self.timeout) if kind == "videos" else
                    fetch_listing(url, self.executable, self.timeout))
            if kind in {"videos", "playlists"} and info.get("id") != identity:
                raise ValueError("Returned metadata belongs to a different video or playlist")
            stamp = now()
            result = {"schema_version": 1, "source_url": url, "fetched_at": stamp,
                      "metadata": public_metadata(info)}
            if info.get("extraction_warnings"):
                result["warnings"] = info["extraction_warnings"]
            if info.get("hidden_count"):
                result["hidden_count"] = info["hidden_count"]
            if kind == "videos":
                history = previous.get("observations", []) if valid else []
                # At most one observation per UTC day; never invent earlier counts.
                result["observations"] = [row for row in history if row["observed_at"][:10] != stamp[:10]] + [observation(info, stamp)]
                if info.get("metadata_warnings"):
                    result["warnings"] = info["metadata_warnings"]
            else:
                if info.get("_type") != "playlist" or not isinstance(info.get("entries"), list):
                    raise ValueError("Expected a complete listing")
                result["entries"] = [{key: entry[key] for key in ("id", "title", "url", "availability") if key in entry}
                                     for entry in info["entries"] if isinstance(entry, dict)]
                if len(result["entries"]) != len(info["entries"]):
                    raise ValueError("Listing contains incomplete entries")
                if kind == "channels":
                    for row in result["entries"]:
                        playlist_identifier(row)
                else:
                    playlist_summary(result, identity)
            atomic_write(path, json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
            return result
        except RuntimeError as exc:
            if re.search(r"(?:HTTP Error 429|Too Many Requests|confirm you.re not a bot)", str(exc), re.I):
                raise ExtractionBlocked("YouTube blocked further requests. Saved metadata is intact; retry later.") from exc
            raise
        finally:
            if self.delay:
                time.sleep(self.delay)


def playlist_summary(archive, identity):
    info = archive["metadata"]
    members = []
    unavailable = 0
    for entry in archive["entries"]:
        video_id = entry.get("id", "")
        if isinstance(video_id, str) and VIDEO_ID.fullmatch(video_id):
            members.append(video_id)
        elif entry.get("title") in {"[Private video]", "[Deleted video]"}:
            unavailable += 1
        else:
            raise ValueError("Playlist contains an unexpected entry")
    return {
        "id": identity, "title": info.get("title") or identity,
        "description": (info.get("description") or "")[:1200],
        "channel": info.get("channel") or info.get("uploader"), "channel_id": info.get("channel_id"),
        "video_ids": members, "video_count": len(members), "unavailable_count": unavailable,
        "hidden_count": archive.get("hidden_count", 0),
        "declared_count": info.get("playlist_count"), "view_count": info.get("view_count"),
        "modified_date": info.get("modified_date"), "fetched_at": archive["fetched_at"], "status": "complete",
    }


def enrich_index(index, archive, checkpoint=lambda data: None):
    """Metadata failures never remove an ID from the deterministic daily schedule."""
    data = deepcopy(index)
    errors = {}
    data["metadata_version"] = 1
    data["metadata_status"] = "partial"
    try:
        for position, video in enumerate(data["videos"], 1):
            identity = video["id"]
            print(f"  video {position}/{len(data['videos'])}: {identity}", flush=True)
            try:
                entry = archive.get("videos", identity, f"https://www.youtube.com/watch?v={identity}")
                video.update(video_summary(entry["metadata"], entry["fetched_at"], detailed=True))
                video["title"] = entry["metadata"].get("title") or video["title"]
                video["metadata_path"] = f"data/metadata/videos/{identity}.json"
                video.pop("metadata_error", None)
            except ExtractionBlocked:
                raise
            except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
                previous = archive.saved("videos", identity)
                if (isinstance(previous, dict) and previous.get("source_url") == f"https://www.youtube.com/watch?v={identity}"
                        and isinstance(previous.get("metadata"), dict) and previous["metadata"].get("id") == identity
                        and isinstance(previous.get("fetched_at"), str)):
                    video.update(video_summary(previous["metadata"], previous["fetched_at"], detailed=True))
                    video["metadata_path"] = f"data/metadata/videos/{identity}.json"
                errors[identity] = str(exc)[-1800:]
                video["metadata_error"] = "Latest metadata request failed; any saved values are from an earlier capture."
                print(f"    metadata unavailable: {exc}", file=sys.stderr)
            # Raw responses are saved after every video; refresh the app snapshot periodically.
            if position % 25 == 0:
                checkpoint(data)

        old_playlists = {row["id"]: row for row in data.get("playlists", [])}
        try:
            if data["source_type"] == "playlist":
                playlist_ids = [(parse_qs(urlsplit(data["source_url"]).query)["list"][0], data["source_title"])]
            else:
                channel_url = data["source_url"].rsplit("/videos", 1)[0] + "/playlists"
                key = hashlib.sha256(channel_url.encode()).hexdigest()[:16]
                listing = archive.get("channels", key, channel_url)
                data["source_metadata"] = {**data.get("source_metadata", {}), **listing["metadata"]}
                playlist_ids = []
                for row in listing["entries"]:
                    identity = playlist_identifier(row)
                    if identity not in {p[0] for p in playlist_ids}:
                        playlist_ids.append((identity, row.get("title") or identity))
            playlists = []
            for identity, title in playlist_ids:
                print(f"  playlist: {title}", flush=True)
                try:
                    entry = archive.get("playlists", identity, f"https://www.youtube.com/playlist?list={identity}")
                    playlists.append(playlist_summary(entry, identity))
                except ExtractionBlocked:
                    raise
                except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
                    errors[identity] = str(exc)[-1800:]
                    previous = deepcopy(old_playlists.get(identity, {"id": identity, "title": title, "video_ids": []}))
                    previous["status"] = "stale" if previous.get("fetched_at") else "unavailable"
                    playlists.append(previous)
            data["playlists"] = playlists
            data["playlist_status"] = "partial" if any(p["status"] != "complete" for p in playlists) else "complete"
        except ExtractionBlocked:
            raise
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
            errors["playlists"] = str(exc)[-1800:]
            data["playlist_status"] = "partial" if old_playlists else "unavailable"
            data["playlists"] = [{**p, "status": "stale"} for p in old_playlists.values()]
        data["metadata_status"] = "partial" if errors else "complete"
        data["metadata_updated_at"] = now()
    finally:
        data["metadata_coverage"] = {
            "videos": len(data["videos"]),
            "detailed": sum(video.get("metadata_status") == "complete" for video in data["videos"]),
            "dated": sum(bool(video.get("upload_date") or video.get("release_date")) for video in data["videos"]),
            "playlists": len(data.get("playlists", [])), "errors": len(errors),
        }
        checkpoint(data)
    return data, errors


def enrich_catalog(root=ROOT, *, only=None, refresh=False, timeout=600, delay=2, executable="yt-dlp", archive=None):
    root = Path(root)
    items = json.loads((root / "data/suggestions.json").read_text())["items"]
    example = read_json(root / "data/geography-now.json")
    if example:
        items.insert(0, {"id": "example-geography-now", "name": example.get("source_title", "Geography Now"),
                         "url": example["source_url"], "example": True})
    if only:
        items = [item for item in items if item["id"] == only or item["name"].casefold() == only.casefold()]
        if not items:
            raise ValueError(f"No catalog source matches {only!r}")
    report = {"started_at": now(), "sources": {}, "errors": {}}
    report_path = root / "data/metadata-build-report.json"
    def save_report():
        report["updated_at"] = now()
        atomic_write(report_path, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    try:
        if archive is None:
            executable = shutil.which(executable)
            if not executable:
                raise RuntimeError("Install yt-dlp before enriching indexes")
            socket.getaddrinfo("www.youtube.com", 443, type=socket.SOCK_STREAM)
            archive = Archive(root, executable=executable, timeout=timeout, delay=delay, refresh=refresh)
        for item in items:
            path = root / "data/geography-now.json" if item.get("example") else root / "data/indexes" / f"{item['id']}.json"
            if not path.exists():
                report["sources"][item["id"]] = {"status": "not_indexed", "name": item["name"]}
                continue
            print(f"Enriching {item['name']}", flush=True)
            try:
                data = validate_index(json.loads(path.read_text()), normalize_source(item["url"]))
                def checkpoint(updated):
                    validate_index(updated, data["source_url"])
                    if item.get("example"):
                        atomic_write(path, json.dumps(updated, ensure_ascii=False, indent=2) + "\n")
                        atomic_write(root / "library.js", "window.DAILY_EXAMPLE = " + javascript_json(updated) + ";\n")
                    else:
                        bundle(root, item, updated)
                updated, errors = enrich_index(data, archive, checkpoint)
                report["sources"][item["id"]] = {"status": updated["metadata_status"], "name": item["name"], **updated["metadata_coverage"]}
                if errors:
                    report["errors"][item["id"]] = errors
            except ExtractionBlocked:
                raise
            except (OSError, ValueError, RuntimeError) as exc:
                report["errors"][item["id"]] = str(exc)
            save_report()
    except (OSError, RuntimeError, KeyboardInterrupt) as exc:
        report["errors"]["build"] = str(exc) or "Interrupted; saved requests will be reused on the next run."
        raise
    finally:
        save_report()
        # IDs/counts/source URLs stay fixed, so the listing manifest remains valid.
        # Leave its error report intact, including any failed listing refreshes.
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="One exact catalog name or ID")
    parser.add_argument("--refresh", action="store_true", help="Refresh metadata and collect new count observations")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--delay", type=float, default=2)
    parser.add_argument("--yt-dlp", default="yt-dlp", dest="executable")
    args = parser.parse_args()
    if args.timeout <= 0 or args.delay < 0:
        parser.error("Timeout must be positive and delay must be nonnegative")
    try:
        report = enrich_catalog(**vars(args))
        return 1 if report["errors"] or any(s["status"] != "complete" for s in report["sources"].values()) else 0
    except KeyboardInterrupt:
        print("Stopped. Rerun to resume from saved metadata.", file=sys.stderr)
        return 130
    except (OSError, ValueError, RuntimeError) as exc:
        print(exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
