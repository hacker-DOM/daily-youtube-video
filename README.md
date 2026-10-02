# Daily YouTube Video

A static web app that chooses one YouTube video per date from a channel or playlist.
No server, API key, build step, framework, or npm install is required.

## Open it

Open `index.html` in a modern browser. The bundled Geography Now snapshot contains
586 videos and works immediately. You can also upload the folder to any static
host, including GitHub Pages; serve it over HTTPS so Web Crypto is available.

The picker and library management work offline. YouTube thumbnails and the
**Watch on YouTube** link require a connection. No videos are downloaded.

## Add channels and playlists

**Browse suggestions** opens 590 suggestions (584 channels and 6 playlists) across
32 categories from the supplied Google Docs text. Search by name, topic, or notes;
filter by category or **Added since GitHub** to see the 29 additions. A suggestion's
**Use channel/playlist** button prepares the index command and opens the import flow.
These are suggestions, not pre-indexed video libraries.

The pasted text had no hyperlinks. Matching names reuse links from the GitHub list;
separately checked links are recorded in `data/sources/verified-links.json`.
Unresolved entries have a labeled **Find on YouTube** link. Paste the selected
channel/playlist URL into the setup form before copying its command.

[CATALOG_DIFF.md](CATALOG_DIFF.md) contains the complete comparison: additions,
category changes, missing resources, description changes, and matching caveats.
Only the pasted document body was compared; other tabs were not available.
Non-video resources are covered in the comparison and excluded from suggestions.

To regenerate the catalog and comparison from the source snapshots:

```sh
npm run catalog
```

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
2. Hash the UTC date, for example `2026-10-01`, with SHA-256.
3. Interpret the digest as a big-endian integer and take it modulo the video count.
4. Select that zero-based position in the saved list.

JavaScript computes the remainder byte by byte to avoid losing precision with
256-bit hashes. The selections match `tools/daily_video.py`. The bundled index
selects `DAIyRVxrjP4` at position 128 (zero-based) for `2026-10-01`.

The date changes at midnight UTC while the page is open. You can browse other dates
with the arrows or calendar; **Back to today** resumes following the current date.
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
stored data. Files are limited to 10 MB and 100,000 entries.

## Files and tests

- `index.html`, `styles.css`, `app.js`: interface and local library management.
- `core.js`: normalization, date handling, and deterministic selection.
- `library.js`: bundled index as a script so opening `index.html` directly works.
- `data/geography-now.json`: an importable copy of the bundled snapshot.
- `tools/`: optional Python indexing tools.

```sh
npm test
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
