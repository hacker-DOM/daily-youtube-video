# Daily YouTube Video

A static web app that chooses one YouTube video per date from a channel or playlist.
No server, API key, build step, framework, or npm install is required.

## Open it

Open `index.html` in a modern browser. The bundled Geography Now snapshot contains
586 videos and works immediately. You can also upload the folder to any static
host, including GitHub Pages; serve it over HTTPS so Web Crypto is available.

Public site: **https://hacker-dom.github.io/daily-youtube-video/**. No sign-in is required.

The picker and library management work offline. YouTube thumbnails and the
**Watch on YouTube** link require a connection. No videos are downloaded.

## Add channels and playlists

**Browse suggestions** opens 590 suggestions (584 channels and 6 playlists) across
32 categories from the supplied Google Docs text. Search by name, topic, or notes;
filter by category or **Added since GitHub** to see the 29 additions. A ready
suggestion's **Use channel/playlist** button loads its bundled snapshot directly.
Visitors need no Python, API key, computer, or manual import. Only the selected
library is loaded, so opening the app does not download the entire catalog.

**Snapshot coverage:** `data/index-build-report.json` and the suggestions dialog
show which source lists have been generated. `data/metadata-build-report.json`
reports enrichment separately. Older ID/title indexes still work; the app shows
missing metadata explicitly until the enrichment pass is run. Network access to
YouTube is needed on the maintainer's machine, never on a visitor's phone.

The pasted text had no hyperlinks. Matching names reuse links from the GitHub list;
separately checked links are recorded in `data/sources/verified-links.json`.
Unresolved entries have a labeled **Find on YouTube** link.

[CATALOG_DIFF.md](CATALOG_DIFF.md) contains the complete comparison: additions,
category changes, missing resources, description changes, and matching caveats.
Only the pasted document body was compared; other tabs were not available.
Non-video resources are covered in the comparison and excluded from suggestions.

To regenerate the catalog and comparison from the source snapshots:

```sh
npm run catalog
```

### Generate all bundled indexes (maintainer only)

With Python 3.10+ and `yt-dlp` on PATH, run from this folder:

```sh
python3 tools/build_indexes.py
```

This walks every linked suggestion, reading all continuation pages. Channels use
the `/videos` tab to exclude Shorts and livestreams; playlists retain Shorts and
recorded livestreams. It saves listing metadata, then enriches each saved video
and discovers channel playlists. It never downloads video or audio files.
Successful snapshots go to `data/indexes/<catalog-id>.json` and `.js`. Listing runs
with extraction or unknown warnings are conservatively rejected because some
continuation failures return a successful exit code with only part of a listing.
Version-age warnings are informational and do not invalidate a successful listing.
YouTube's explicit hidden/unavailable-video notices are also allowed: warnings and
hidden counts are saved, and playlist cards show how many entries are hidden.
`indexes-manifest.js` records which sources are ready. The raw indexes and metadata
stay local and are ignored by Git. Use the publishing procedure below to package
and publish compressed copies.

Rerunning resumes by skipping successful snapshots. Failed sources stay unavailable,
and failed refreshes retain their previous good snapshot. Personal yt-dlp settings
are ignored so cookies, download settings, and playlist limits cannot leak into
the build. Each extraction request has a 10-minute timeout; requests and sources are spaced out.
Large channels may need `--timeout 1800`.

```sh
python3 tools/build_indexes.py --only 'Periodic Videos'
python3 tools/build_indexes.py --refresh
python3 tools/build_indexes.py --prepare-only
python3 tools/build_indexes.py --metadata listing  # Fast lists without individual watch-page requests
```

`--prepare-only` rebuilds bundles from saved JSON without contacting YouTube.
`data/index-build-report.json` records failures and unresolved URLs. Exit code 0
means the requested sources completed (or a prepare-only run completed); 1 means
some sources or metadata remain incomplete, and 2 means generation could not start.
Without `--only`, the request covers the full catalog. Missing links
must be verified in `data/sources/verified-links.json`, then `npm run catalog`
regenerates the source list. Renamed, removed, or restricted channels may need
individual attention. YouTube availability is checked by the generator, not by a
phone visiting the site.

### Video metadata, charts, and channel playlists

The full build is resumable at **video and playlist level**. To enrich the source
lists you already generated, without waiting for the rest of the catalog:

```sh
python3 tools/enrich_indexes.py
# Or start with one source:
python3 tools/enrich_indexes.py --only 'Geography Now'
# Capture fresh statistics later, preserving previous observations:
python3 tools/enrich_indexes.py --refresh
```

Run only one builder at a time. Finish or stop an older listing run before starting
these commands. Full enrichment makes individual watch-page requests, so it is
substantially slower than flat listings. Successful requests are reused across
channels and playlists. Rerunning without `--refresh` retries missing data. A 429
or bot-check error stops the pass and preserves its checkpoints for a later retry.
The bundled Geography Now example is enriched too.

Each compact index preserves available upload/release dates, duration, views,
likes, comment count, creator information, language, license, tags/categories,
a description excerpt, capture timestamps, and metadata completeness. Counts
hidden or omitted by YouTube remain missing. Exact upload dates come from the
watch-page extractor; relative dates from flat listings are not presented as exact.
Dates reported by yt-dlp describe YouTube's UTC publication day; daily selection
continues to use the visitor's **local** calendar date.

Full public metadata is saved separately in `data/metadata/videos/<video-id>.json`:
complete descriptions and tags, chapters, thumbnails, available caption languages,
release details, and the other descriptive fields listed in `tools/video_metadata.py`.
This is deliberately not a dump of every extractor-internal field: media formats,
expiring stream URLs, request headers, cookies, transcript contents, and comment
bodies are excluded. Compact indexes limit descriptions to 1,200 characters and
lists of tags/categories to 24 entries; the archive preserves the originals.
The selected video's **Full metadata JSON** link opens its archive on the published site.

Each video's archive also keeps `observations`, with views/likes/comments captured
on each refresh (at most one per UTC day). These are real observations starting
with the first scrape; historical engagement cannot be recovered retroactively.
The app's views/likes charts show **captured lifetime totals grouped by upload
month or year**, not engagement earned during those months or years. Unknown
counts are visibly distinguished from zero. Coverage, date ranges, keyboard
navigation, tooltips, and a data table are included.

For a channel, the builder reads its `/playlists` tab, then every continuation page
of every exposed public playlist. `data/metadata/channels/` preserves discovery,
and `data/metadata/playlists/` preserves descriptions, owner information, declared
counts, and ordered membership. The compact index contains those playlists and
their video IDs, including repeats and videos by other creators. They do not get
added to the channel's daily selection pool. The app shows playlist cards and
which saved playlists contain the selected video. Membership covers public lists
exposed by that source; it cannot discover private lists or every playlist made by
other people containing the same video. Explicit playlist sources index their own
membership without crawling other playlists by the owner.

Metadata failures leave video IDs in place, with missing or older statistics
clearly marked. Failed playlist refreshes retain older membership and mark it stale.
Use `data/metadata-build-report.json` to inspect failures. The publishing tool
packages the indexes, archives, bundled example, and manifest. Import/export moves the compact index, including chart data
and memberships; full archives and observation history stay in their separate files. To update a
library already saved in a browser, choose it again in **Browse suggestions** or
import its new JSON. The bundled Geography Now metadata updates automatically
when its video IDs still match the saved list.

### Publish the collected library

The repository uses three branches: `main` contains the app and collection tools;
`gh-pages` contains the public website; `archive` contains the compressed full
metadata. The multi-gigabyte raw collection is not committed. GitHub Pages has a
[1 GB site limit](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
so full metadata is fetched on demand from the public `archive` branch through
`raw.githubusercontent.com`. No account or API key is needed to read it.

With collection stopped, package a deployment:

```sh
python3 tools/build_site.py \
  --metadata-base https://raw.githubusercontent.com/hacker-DOM/daily-youtube-video/archive \
  --archive-output .publish/archive
```

The default website output is `.publish/site`. The tool verifies lossless gzip
round trips and matching source counts. It preserves full descriptions, metadata,
playlist records, and observation history. Video archives are grouped into small
files by a case-preserving hexadecimal prefix. The browser decompresses the selected
library and downloads an individual video's original JSON when requested.

Publish `.publish/archive` to `archive` first, then set the metadata URL in
`.publish/site/site-config.js` to that archive commit's full SHA instead of `archive`.
Publish `.publish/site` to `gh-pages`; GitHub Pages serves that branch's root.
Use normal commits and pushes on both branches, preserving their existing history.
For application-only changes, omit `--archive-output` and reuse the current pinned
metadata URL. Pushing `main` alone does not update the public website.

Before publishing, run `npm test`, `npm run test:indexes`, and the browser check.
To test the packaged site, serve `.publish` with a local HTTP server and use
`DAILY_SITE_URL=http://127.0.0.1:8000/site/index.html node tests/browser-smoke.cjs`.
The default browser check still opens the original local app. A fresh source clone
skips the collected-dataset integration test until `data/indexes/` is populated;
the fixture-based application and packaging tests run without the collection.

### Import a custom source (optional)

Click **Add a channel or playlist** and import a JSON index from the Python picker.
Its original channel-only cache format is supported too. Imports and saved libraries
stay in browser local storage; they are never uploaded. You can export a library
to move it to another device, back it up, or keep an old selection schedule.

To create a fresh index locally, use the included optional Python tool:

```sh
uv run tools/index_source.py '@GeographyNow' --output my-library.json
uv run tools/index_source.py '@periodicvideos' --output elements.json
uv run tools/index_source.py 'https://www.youtube.com/playlist?list=YOUR_PLAYLIST_ID' --output playlist.json
```

This tool requires Python 3.10+ and yt-dlp; `uv run` handles them. With an existing
Python environment, install yt-dlp and run `python tools/index_source.py …` instead.
It is a one-time indexing tool, not an app server. Internet access to YouTube is
needed only while generating or refreshing the index.

Import the generated file. **Update library** opens the same import flow. Updating
an existing source replaces its snapshot, so export the old one first if needed.
Channel indexes exclude Shorts and livestreams. Playlist indexes include Shorts
and recorded livestreams if present, and deduplicate repeated video IDs.

### Why import instead of fetching a channel URL in the page?

YouTube's cross-origin restrictions prevent a normal website from reading its full
channel or playlist listings directly. Browser implementations of the unofficial
API require a proxy ([YouTube.js browser documentation](https://ytjs.dev/guide/browser-usage)).
An arbitrary live URL lookup would require a server/proxy, a browser extension,
or a different approach using the official API. This app uses saved lists to keep
the requested server-free and API-key-free model. It does not use a public proxy.

## Selection rules

1. Deduplicate video IDs and sort them using ASCII/Unicode code point order,
   matching Python's sorting for YouTube's ASCII IDs.
2. Hash the device's local date, for example `2026-10-01`, with SHA-256.
3. Interpret the digest as a big-endian integer and take it modulo the video count.
4. Select that zero-based position in the saved list.

JavaScript computes the remainder byte by byte to avoid losing precision with
256-bit hashes. The selections match `tools/daily_video.py`. The bundled index
selects `DAIyRVxrjP4` at position 128 (zero-based) for `2026-10-01`.

The date changes at local midnight while the page is open and is checked again when
you return to the tab. The countdown accounts for daylight saving changes. You can
browse other dates with the arrows or calendar; **Back to today** resumes following
the device's current local date. Devices in different time zones get the same pick
when their calendar date and library match, even if their midnights occur at different times.
The URL may include `?date=2026-10-01` to set the initial date.

Different dates may repeat videos. Changing the index may change selections for
any date, including the past. A saved list is not a guarantee of future availability
or regional playability. The app links to the selected video without silently
substituting a different one when it is unavailable.

## Storage

Libraries are saved in local storage. Storage is specific to the browser and origin;
switching hosts or moving a local file may require importing libraries again.
Some browsers restrict local-file storage. When saving fails, the current session
continues with a notice to export before closing. Private browsing may discard
stored data. Files are limited to 50 MB and 100,000 entries.

## Files and tests

- `index.html`, `styles.css`, `app.js`: interface and local library management.
- `core.js`: normalization, date handling, and deterministic selection.
- `insights.js`, `insights-ui.js`, `insights.css`: metadata, charts, and playlist exploration.
- `library.js`: bundled index as a script so opening `index.html` directly works.
- `data/geography-now.json`: an importable copy of the bundled snapshot.
- `tools/`: optional Python indexing tools.

```sh
npm test
npm run test:indexes
```

Tests use Node's built-in runner and have no package dependencies. The cross-language
parity test also uses `python3` (standard library only). They verify
Python-compatible picks, ordering, invalid imports, date boundaries, and the
bundled dataset. `tests/browser-smoke.cjs`, if run, uses an installed Chromium
browser over its debugging pipe to exercise the actual page without a web server:

```sh
node tests/browser-smoke.cjs
```

It defaults to Google Chrome's macOS path; set `BROWSER_PATH` on other systems.
The browser check requires an environment that permits launching Chromium.
