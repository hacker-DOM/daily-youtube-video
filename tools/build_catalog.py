"""Rebuild the suggestions and comparison from the checked-in source snapshots."""

from collections import defaultdict, Counter
import hashlib
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlsplit, parse_qs, urlencode

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "data/sources"
DOC_URL = "https://docs.google.com/document/d/1M5kvDldTCDCNgrlNx6fcDF1h81fnKX6Ovvm20L06Jtk/edit"
GITHUB_URL = "https://github.com/PrejudiceNeutrino/YouTube_Channels"
RESOURCE_CATEGORIES = {
    "Podcasts", "Useful Websites", "Cool Websites", "Browser Extensions",
    "Online Learning", "Software", "Apps", "Kids Science Kits", "Misc",
}
CATEGORY_NAMES = {
    "Anatomy and Medicine": "Anatomy/Medicine",
    "Houseplants and Terrariums": "Houseplants/Terrariums",
    "Websites": "Useful Websites",
}


def key(name):
    return " ".join(unicodedata.normalize("NFKC", name).casefold().split())


def read_github():
    entries = []
    category = None
    for line in (SOURCES / "github-readme.md").read_text().splitlines():
        if line.startswith("## "):
            category = line[3:].strip().rstrip(":")
            category = CATEGORY_NAMES.get(category, category)
        match = re.match(r"^\* \[(.*)\]\((https?://[^\s]+)\)(.*)$", line)
        if match and category and category != "Table of Contents":
            entries.append({"name": match[1].strip(), "url": match[2], "note": match[3].lstrip(" -"), "category": category})
    return entries


def read_paste(github):
    # Match complete known names first: titles themselves can contain ' - '.
    known_names = sorted({entry["name"] for entry in github}, key=len, reverse=True)
    entries = []
    category = None
    for line in (SOURCES / "google-doc-pasted.txt").read_text().splitlines():
        line = line.strip()
        if line.endswith(":"):
            category = line[:-1]
            continue
        if not line or line.startswith("*"):
            continue
        name = next((name for name in known_names if key(line) == key(name) or key(line).startswith(key(name) + " - ")), None)
        name = name or line.split(" - ", 1)[0]
        entries.append({"name": name, "note": line[len(name):].lstrip(" -"), "category": category})
    return entries


def is_youtube(url):
    return urlsplit(url).hostname in {"youtube.com", "www.youtube.com", "m.youtube.com"}


def canonical_url(url):
    parts = urlsplit(url)
    playlist = parse_qs(parts.query).get("list", [None])[0]
    if playlist:
        return "https://www.youtube.com/playlist?" + urlencode({"list": playlist})
    path = re.sub(r"/(videos|playlists|featured|about|shorts|streams)/?$", "", parts.path)
    return "https://www.youtube.com" + path.rstrip("/")


def group_by_name(entries):
    groups = defaultdict(list)
    for entry in entries:
        groups[key(entry["name"])].append(entry)
    return groups


def build():
    github = read_github()
    pasted = read_paste(github)
    old_names = group_by_name(github)
    new_names = group_by_name(pasted)
    verified = json.loads((SOURCES / "verified-links.json").read_text())
    suggestions = {}
    occurrences = Counter()
    excluded = []
    for entry in pasted:
        if entry["category"] in RESOURCE_CATEGORIES:
            continue
        matches = old_names.get(key(entry["name"]), [])
        if "[website]" in entry["note"] or (matches and all(not is_youtube(row["url"]) for row in matches)):
            excluded.append(entry)
            continue
        urls = list(dict.fromkeys(canonical_url(row["url"]) for row in matches if is_youtube(row["url"])))
        evidence = GITHUB_URL if urls else None
        if entry["name"] in verified:
            urls = [canonical_url(verified[entry["name"]]["url"])]
            evidence = verified[entry["name"]]["evidence"]
        # Keep distinct same-name channels (the two Physics Explained entries).
        occurrence_key = (key(entry["name"]), entry["category"])
        occurrence = occurrences[occurrence_key]
        occurrences[occurrence_key] += 1
        url = urls[min(occurrence, len(urls) - 1)] if urls else None
        identity = url or "name:" + key(entry["name"])
        if identity not in suggestions:
            suggestions[identity] = {
                "id": hashlib.sha256(identity.encode()).hexdigest()[:16],
                "name": entry["name"], "aliases": [], "categories": [], "notes": [],
                "url": url, "url_source": evidence,
                "kind": "playlist" if url and "/playlist?" in url else "channel",
                "added_since_github": key(entry["name"]) not in old_names,
                "search_url": "https://www.youtube.com/results?" + urlencode({"search_query": entry["name"]}),
            }
        item = suggestions[identity]
        if entry["name"] != item["name"] and entry["name"] not in item["aliases"]:
            item["aliases"].append(entry["name"])
        if entry["category"] not in item["categories"]:
            item["categories"].append(entry["category"])
        if entry["note"] and entry["note"] not in item["notes"]:
            item["notes"].append(entry["note"])

    items = list(suggestions.values())
    categories = list(dict.fromkeys(entry["category"] for entry in pasted if entry["category"] not in RESOURCE_CATEGORIES))
    catalog = {
        "version": 1, "source_url": DOC_URL, "reference_url": GITHUB_URL,
        "source_date": "2026-10-01", "source_scope": "User-pasted document body; other document tabs were not inspected.",
        "categories": categories, "items": items,
    }
    additions = [rows[0] for name, rows in new_names.items() if name not in old_names]
    absent = [rows[0] for name, rows in old_names.items() if name not in new_names]
    movements = []
    notes_changed = []
    for name in old_names.keys() & new_names.keys():
        old_categories = {row["category"] for row in old_names[name]} - {"Personal Favorites"}
        new_categories = {row["category"] for row in new_names[name]}
        if old_categories != new_categories:
            movements.append({"name": new_names[name][0]["name"], "from": sorted(old_categories), "to": sorted(new_categories)})
        old_notes = sorted({row["note"] for row in old_names[name] if row["category"] != "Personal Favorites"})
        new_notes = sorted({row["note"] for row in new_names[name]})
        if old_notes != new_notes:
            notes_changed.append({"name": new_names[name][0]["name"], "from": old_notes, "to": new_notes})
    counts = {"github_rows": len(github), "pasted_rows": len(pasted), "suggestions": len(items),
              "channels": sum(item["kind"] == "channel" for item in items),
              "playlists": sum(item["kind"] == "playlist" for item in items),
              "categories": len(categories), "youtube_additions": sum(item["added_since_github"] for item in items),
              "all_resource_additions": len(additions), "absent_names": len(absent),
              "unresolved_links": sum(item["url"] is None for item in items)}
    diff = {"scope": catalog["source_scope"], "counts": counts, "additions": additions,
            "absent_from_paste": absent, "category_changes": sorted(movements, key=lambda row: key(row["name"])),
            "note_changes": sorted(notes_changed, key=lambda row: key(row["name"])), "excluded_from_suggestions": excluded}
    (ROOT / "data/suggestions.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "suggestions-data.js").write_text("// Generated by tools/build_catalog.py from the pasted document.\nwindow.DAILY_SUGGESTIONS = " + json.dumps(catalog, ensure_ascii=True, separators=(",", ":")) + ";\n")
    (ROOT / "data/catalog-diff.json").write_text(json.dumps(diff, ensure_ascii=False, indent=2) + "\n")
    report = ["# Pasted Google Doc vs. GitHub", "",
              f"Compared the user-pasted document body with the [GitHub README]({GITHUB_URL}) fetched on 2026-10-01. The [Google Doc]({DOC_URL}) mentions additional tabs; these were not provided. Absence here means absence from the paste, not necessarily deletion from the full document.", "",
              f"The app includes **{counts['suggestions']} suggestions**: {counts['channels']} channels and {counts['playlists']} playlists across {counts['categories']} categories. There are **{counts['youtube_additions']} new YouTube entries**, with no GitHub channel names missing from the paste.", "",
              "## YouTube additions", ""]
    grouped = defaultdict(list)
    for entry in additions:
        if entry["category"] not in RESOURCE_CATEGORIES:
            grouped[entry["category"]].append(entry["name"])
    report += [f"- **{category}:** {', '.join(names)}." for category, names in grouped.items()]
    report += ["", "## Category and structural changes", "",
               "- GitHub's 30-item Personal Favorites section is absent from the pasted body; every favorite still appears in the subject categories.",
               "- Anatomy and Medicine → Anatomy/Medicine; Houseplants and Terrariums → Houseplants/Terrariums; Websites → Useful Websites.",
               "- New resource sections: Cool Websites (12 entries) and Kids Science Kits (4 entries).", ""]
    report += [f"- **{row['name']}:** {', '.join(row['from'])} → {', '.join(row['to'])}." for row in diff["category_changes"]]
    report += ["", "## Other resource additions", ""]
    grouped = defaultdict(list)
    for entry in additions:
        if entry["category"] in RESOURCE_CATEGORIES:
            grouped[entry["category"]].append(entry["name"])
    report += [f"- **{category}:** {', '.join(names)}." for category, names in grouped.items()]
    report += ["", "## Names absent from the paste", ""]
    report += [f"- {entry['name']} ({entry['category']})." for entry in absent]
    report += ["", "## Notes and matching caveats", "",
               "- Compared names after normalizing case, Unicode, and whitespace. Subject categories are matched after the three heading renames above. Reordering within categories is not counted as an addition/removal.",
               "- The paste has no hyperlinks, so link changes cannot be compared. Matching entries reuse links from GitHub; new direct links require separate evidence. Unresolved suggestions use an explicitly labeled YouTube search link.",
               "- The two Physics Explained entries correspond to two different GitHub URLs. Both are retained in source order; the plain-text paste cannot independently verify that URL mapping.",
               "- Alaska to Argentina on Honda 90's and c90adventures point to the same playlist in GitHub. They become one suggestion with both names and categories. Tasting History is also merged across its two categories.",
               "- Scrimba is explicitly a website, so it is excluded from the video suggestions. Podcasts, software, websites, and other resources are included in this comparison, not in the video catalog.",
               "- AudioBookBay appears twice in Useful Websites in the paste. It is counted once when comparing resource names.",
               "- Source categorization is retained; inclusion is not a new endorsement of every channel or resource.", "", "### Description changes", ""]
    for row in diff["note_changes"]:
        before = " / ".join(row["from"]) or "(none)"
        after = " / ".join(row["to"]) or "(none)"
        report.append(f"- **{row['name']}:** {before} → {after}.")
    (ROOT / "CATALOG_DIFF.md").write_text("\n".join(report) + "\n")
    print(json.dumps(counts, indent=2))


if __name__ == "__main__":
    build()
