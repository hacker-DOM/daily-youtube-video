"""Durable public metadata, separate from expiring media URLs and player internals."""

from datetime import date
import math

# Preserve descriptive fields in full in the archive. No cookies, request headers,
# signed media URLs, formats, subtitle download URLs, or comment bodies are saved.
PUBLIC_FIELDS = set("""
id title fulltitle alt_title description display_id webpage_url original_url
uploader uploader_id uploader_url channel channel_id channel_url channel_follower_count
channel_is_verified upload_date release_date timestamp release_timestamp modified_date
modified_timestamp duration duration_string view_count like_count dislike_count
comment_count concurrent_view_count average_rating age_limit availability live_status
is_live was_live playable_in_embed tags categories license location language
creators creator artist artists album album_artist track track_number release_year
series season season_number episode episode_number cast genre genres
thumbnail thumbnails chapters heatmap automatic_captions subtitles
playlist_count playlist_id playlist_title playlist_uploader playlist_uploader_id
""".split())
COUNTS = ("view_count", "like_count", "comment_count", "channel_follower_count")


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def iso_day(value):
    if not isinstance(value, str):
        return None
    try:
        if len(value) == 8 and value.isdigit():
            value = f"{value[:4]}-{value[4:6]}-{value[6:]}"
        return date.fromisoformat(value).isoformat() if len(value) == 10 else None
    except ValueError:
        return None


def public_metadata(info):
    result = {key: value for key, value in info.items() if key in PUBLIC_FIELDS and value is not None}
    # Keep available caption languages, without expiring signed transcript URLs.
    for key in ("automatic_captions", "subtitles"):
        if isinstance(result.get(key), dict):
            result[key] = sorted(result[key])
    return result


def video_summary(info, fetched_at, *, detailed=False):
    result = {key: info[key] for key in (*COUNTS, "duration", "timestamp", "release_timestamp") if number(info.get(key))}
    for key in ("channel", "channel_id", "uploader", "language", "license", "availability", "live_status"):
        if isinstance(info.get(key), str):
            result[key] = info[key]
    for key in ("upload_date", "release_date"):
        # Flat listings may carry relative/approximate dates. Charts use watch-page dates only.
        if detailed and (value := iso_day(info.get(key))):
            result[key] = value
    if isinstance(info.get("description"), str):
        result["description"] = info["description"][:1200]
        result["description_truncated"] = len(info["description"]) > 1200
    for key in ("tags", "categories"):
        if isinstance(info.get(key), list):
            result[key] = [value for value in info[key] if isinstance(value, str)][:24]
    result["metadata_fetched_at"] = fetched_at
    result["metadata_status"] = "complete" if detailed else "listing"
    return result


def observation(info, fetched_at):
    return {"observed_at": fetched_at, **{key: info[key] for key in COUNTS if number(info.get(key))}}
