#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["yt-dlp"]
# ///
"""Pick a daily video from a YouTube channel or playlist, without a Data API key."""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit


VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
CHANNEL_ID = re.compile(r"UC[A-Za-z0-9_-]{22}\Z")
PLAYLIST_ID = re.compile(r"(?:PL|UU|FL|OLAK5uy_)[A-Za-z0-9_-]+\Z")


def normalize_source(source: str) -> str:
    """Normalize channel, playlist, and video-with-playlist links."""
    source = source.strip()
    if PLAYLIST_ID.fullmatch(source):
        return f"https://www.youtube.com/playlist?list={source}"
    if source.startswith(("youtube.com/", "www.youtube.com/", "m.youtube.com/", "youtu.be/")):
        source = "https://" + source
    parsed = urlsplit(source)
    if parsed.scheme in {"http", "https"} and parsed.netloc.lower() in {
        "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
    }:
        playlist_ids = parse_qs(parsed.query, keep_blank_values=True).get("list")
        if playlist_ids is not None:
            if len(playlist_ids) != 1 or not PLAYLIST_ID.fullmatch(playlist_ids[0]):
                raise ValueError("Use a saved playlist or uploads playlist; dynamic Mixes are unsupported.")
            return f"https://www.youtube.com/playlist?list={playlist_ids[0]}"
    return channel_videos_url(source)


def channel_videos_url(channel: str) -> str:
    """Accept an @handle, UC channel ID, or channel URL; select only /videos."""
    channel = channel.strip()
    if CHANNEL_ID.fullmatch(channel):
        channel = f"https://www.youtube.com/channel/{channel}"
    elif channel.startswith("@"):
        channel = f"https://www.youtube.com/{channel}"
    elif channel.startswith(("youtube.com/", "www.youtube.com/", "m.youtube.com/")):
        channel = "https://" + channel

    parsed = urlsplit(channel)
    if parsed.scheme not in {"https", "http"} or parsed.netloc.lower() not in {
        "youtube.com", "www.youtube.com", "m.youtube.com",
    }:
        raise ValueError("Use a YouTube channel URL, @handle, or UC channel ID.")
    parts = parsed.path.strip("/").split("/")
    if parts[0].startswith("@") and len(parts[0]) > 1:
        root_size = 1
    elif len(parts) >= 2 and parts[0] in {"channel", "c", "user"} and parts[1]:
        root_size = 2
        if parts[0] == "channel" and not CHANNEL_ID.fullmatch(parts[1]):
            raise ValueError("Invalid UC channel ID.")
    elif parts[0] and parts[0] not in {"watch", "shorts", "playlist", "results", "feed", "embed", "live", "redirect", "channel", "c", "user"}:
        # Older channel links use a direct vanity path, e.g. /greymatter/videos.
        root_size = 1
    else:
        raise ValueError("Expected a channel URL, not a video or playlist URL.")
    if len(parts) > root_size and (
        len(parts) != root_size + 1
        or parts[-1] not in {"videos", "shorts", "streams", "featured", "playlists", "about", "community"}
    ):
        raise ValueError("Unrecognized channel URL path.")
    return "https://www.youtube.com/" + "/".join(parts[:root_size]) + "/videos"


def collect_videos(entries, *, channel_only: bool = True) -> list[dict]:
    """Consume every page before counting; deduplicate and order by video ID."""
    videos = {}
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("id"), str)
            or not VIDEO_ID.fullmatch(entry["id"])
        ):
            raise ValueError("YouTube returned an incomplete or unexpected video entry; index not saved.")
        video_id = entry["id"]
        # The /videos tab is the primary Shorts filter. Never infer Shorts from duration.
        if channel_only and any("/shorts/" in (entry.get(key) or "") for key in ("url", "webpage_url")):
            continue
        if entry.get("live_status") in {"is_live", "is_upcoming", "post_live"}:
            continue
        if channel_only and entry.get("live_status") == "was_live":
            continue
        if entry.get("availability") in {"private", "premium_only", "subscriber_only", "needs_auth"}:
            continue
        if entry.get("title") in {"[Private video]", "[Deleted video]"}:
            continue
        videos.setdefault(video_id, {
            "id": video_id,
            "title": entry.get("title") or video_id,
        })
    if not videos:
        raise ValueError("No eligible videos found in this channel or playlist.")
    return [videos[video_id] for video_id in sorted(videos)]


def fetch_index(source_url: str) -> dict:
    is_playlist = urlsplit(source_url).path == "/playlist"
    try:
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import DownloadError
    except ImportError as exc:
        raise RuntimeError("Install yt-dlp with: python -m pip install -U yt-dlp") from exc

    options = {
        "extract_flat": True,
        "skip_download": True,
        "quiet": True,
        "ignoreerrors": False,
        "cachedir": False,
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 2,
        # Otherwise yt-dlp can warn and stop early on a broken continuation page.
        "extractor_args": {"youtube": {"raise_incomplete_data": ["true"]}},
    }
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(source_url, download=False)
            if not info or info.get("_type") != "playlist" or "entries" not in info:
                raise ValueError("YouTube did not return a channel or playlist listing.")
            videos = collect_videos(info["entries"], channel_only=not is_playlist)
    except DownloadError as exc:
        raise RuntimeError(f"Could not index YouTube: {exc}") from exc

    return {
        "version": 1,
        "source_url": source_url,
        "source_type": "playlist" if is_playlist else "channel",
        "source_title": (info.get("title") if is_playlist else info.get("channel")) or info.get("title") or source_url,
        "channel_id": info.get("channel_id"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "videos": videos,
    }


def cache_path(source_url: str, cache_dir: Path) -> Path:
    key = hashlib.sha256(source_url.encode("utf-8")).hexdigest()
    return cache_dir / f"{key}.json"


def read_index(path: Path, source_url: str) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("Unknown index format")
        # Accept channel snapshots saved before playlist support was added.
        if (
            "source_type" not in data and "source_title" not in data
            and isinstance(data.get("channel"), str)
            and urlsplit(source_url).path.endswith("/videos")
        ):
            data = {**data, "source_type": "channel", "source_title": data["channel"]}
        if (
            data.get("source_url") != source_url
            or data.get("source_type") not in ("channel", "playlist")
            or not isinstance(data.get("source_title"), str)
            or not isinstance(data.get("fetched_at"), str)
        ):
            raise ValueError("Invalid index metadata")
        videos = data.get("videos")
        if not isinstance(videos, list) or not videos or not all(
            isinstance(video, dict)
            and isinstance(video.get("id"), str)
            and VIDEO_ID.fullmatch(video["id"])
            and isinstance(video.get("title"), str)
            for video in videos
        ):
            raise ValueError("Invalid video list")
        ids = [video["id"] for video in videos]
        if ids != sorted(set(ids)):
            raise ValueError("Video IDs must be unique and sorted")
    except ValueError as exc:
        raise ValueError(f"Invalid saved index at {path}; run with --refresh to rebuild it.") from exc
    return data


def load_index(source_url: str, cache_dir: Path, refresh: bool = False) -> dict:
    path = cache_path(source_url, cache_dir)
    if path.exists() and not refresh:
        return read_index(path, source_url)

    print(f"Indexing {source_url} (metadata only)...", file=sys.stderr)
    data = fetch_index(source_url)
    # Write only after full extraction; a failed refresh preserves the previous index.
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as out:
            temporary_path = Path(out.name)
            json.dump(data, out, ensure_ascii=False, indent=2)
            out.write("\n")
        temporary_path.replace(path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return data


def choose_video(index: dict, day: date) -> dict:
    videos = index["videos"]
    if not videos:
        raise ValueError("Cannot choose from an empty index.")
    iso_date = day.isoformat()
    digest = hashlib.sha256(iso_date.encode("ascii")).digest()
    offset = int.from_bytes(digest, "big") % len(videos)
    video = videos[offset]
    return {
        "date": iso_date,
        "source": index["source_title"],
        "source_type": index["source_type"],
        "source_url": index["source_url"],
        "count": len(videos),
        "index": offset,  # Zero-based position in the saved, ID-sorted list.
        "id": video["id"],
        "title": video["title"],
        "url": f"https://www.youtube.com/watch?v={video['id']}",
        "indexed_at": index["fetched_at"],
    }


def iso_date(value: str) -> date:
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Use a valid date in YYYY-MM-DD format.") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Channel/playlist URL, @handle, UC channel ID, or playlist ID")
    parser.add_argument("--date", type=iso_date, default=None, help="YYYY-MM-DD; default: today's local date")
    parser.add_argument("--refresh", action="store_true", help="Rebuild the saved index (may change past picks)")
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/youtube-index"))
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    args = parser.parse_args(argv)
    try:
        source_url = normalize_source(args.source)
        index = load_index(source_url, args.cache_dir, args.refresh)
        result = choose_video(index, args.date or date.today())
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{result['date']} — {result['source']}")
        print(f"Video {result['index'] + 1} of {result['count']}: {result['title']}")
        print(result["url"])
        print(f"Index saved: {result['indexed_at']} (use --refresh to update)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
