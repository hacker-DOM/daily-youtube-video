import contextlib
from copy import deepcopy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from enrich_indexes import Archive, ExtractionBlocked, enrich_index, enrich_catalog, fetch_video
from build_indexes import build, fetch_listing
from video_metadata import public_metadata, video_summary

VIDEO_A, VIDEO_B, FOREIGN = "aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"
SOURCE = "https://www.youtube.com/@fixture/videos"


def snapshot():
    return {"version": 1, "source_url": SOURCE, "source_type": "channel", "source_title": "Fixture",
            "channel_id": "UC" + "x" * 22, "fetched_at": "2026-10-01T00:00:00Z",
            "videos": [{"id": identity, "title": identity} for identity in (VIDEO_A, VIDEO_B)]}


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.calls = []
        self.blocked = set()

    def fetch(self, url, kind):
        self.calls.append((url, kind))
        if kind in self.blocked or any(identity in url for identity in self.blocked):
            raise RuntimeError("Fixture request failed")
        if kind == "videos":
            identity = url.split("v=")[1]
            return {"id": identity, "title": "Actual title", "upload_date": "20240229", "duration": 123,
                    "view_count": 1000, "like_count": 0, "comment_count": 3, "description": "x" * 2000,
                    "tags": ["science"], "chapters": [{"title": "Intro", "start_time": 0, "end_time": 20}],
                    "formats": [{"url": "https://example.com/signed-media?token=secret"}],
                    "http_headers": {"Cookie": "secret"}, "automatic_captions": {"en": [{"url": "secret"}]}}
        if kind == "channels":
            return {"_type": "playlist", "id": "UC" + "x" * 22, "title": "Fixture playlists", "entries": [
                {"id": "PLfixture", "title": "Science series"}, {"id": "PLfixture", "title": "Duplicate"}]}
        return {"_type": "playlist", "id": "PLfixture", "title": "Science series", "description": "A collection",
                "channel": "Fixture", "playlist_count": 4, "entries": [
                    {"id": VIDEO_A}, {"id": FOREIGN}, {"id": VIDEO_A}, {"title": "[Private video]"}]}

    def archive(self, **kwargs):
        return Archive(self.root, fetch=self.fetch, delay=0, **kwargs)

    def run_enrich(self, index=None, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return enrich_index(index or snapshot(), self.archive(**kwargs))

    def test_full_metadata_archived_compact_index_and_public_memberships(self):
        data, errors = self.run_enrich()
        self.assertEqual(errors, {})
        self.assertEqual(data["metadata_status"], "complete")
        video = data["videos"][0]
        self.assertEqual(video["upload_date"], "2024-02-29")
        self.assertEqual(video["like_count"], 0)
        self.assertEqual(len(video["description"]), 1200)
        self.assertTrue(video["description_truncated"])
        archive = json.loads((self.root / video["metadata_path"]).read_text())
        self.assertEqual(len(archive["metadata"]["description"]), 2000)
        self.assertEqual(archive["metadata"]["automatic_captions"], ["en"])
        self.assertIn("chapters", archive["metadata"])
        self.assertNotIn("formats", archive["metadata"])
        self.assertNotIn("http_headers", archive["metadata"])
        self.assertNotIn("secret", json.dumps(archive))
        self.assertEqual(len(data["playlists"]), 1)
        playlist = data["playlists"][0]
        self.assertEqual(playlist["video_ids"], [VIDEO_A, FOREIGN, VIDEO_A])
        self.assertEqual(playlist["unavailable_count"], 1)
        self.assertEqual(playlist["declared_count"], 4)
        self.assertEqual(len(data["videos"]), 2)

    def test_failures_keep_video_ids_and_resume_only_missing_requests(self):
        self.blocked.add(VIDEO_B)
        partial, errors = self.run_enrich()
        self.assertEqual(partial["metadata_status"], "partial")
        self.assertEqual([v["id"] for v in partial["videos"]], [VIDEO_A, VIDEO_B])
        self.assertNotIn("upload_date", partial["videos"][1])
        self.assertIn(VIDEO_B, errors)
        self.calls.clear(); self.blocked.clear()
        complete, errors = self.run_enrich(partial)
        self.assertEqual(complete["metadata_status"], "complete")
        self.assertEqual(self.calls, [(f"https://www.youtube.com/watch?v={VIDEO_B}", "videos")])
        self.assertNotIn("metadata_error", complete["videos"][1])

    def test_failed_refresh_preserves_video_details_and_playlist_membership(self):
        original, _ = self.run_enrich()
        self.blocked.update({VIDEO_A, "channels"})
        refreshed, errors = self.run_enrich(original, refresh=True)
        self.assertEqual(refreshed["videos"][0]["view_count"], 1000)
        self.assertIn("metadata_error", refreshed["videos"][0])
        self.assertEqual(refreshed["playlists"][0]["video_ids"], original["playlists"][0]["video_ids"])
        self.assertEqual(refreshed["playlists"][0]["status"], "stale")
        self.assertEqual(refreshed["playlist_status"], "partial")
        self.assertIn("playlists", errors)

    def test_explicit_playlist_does_not_discover_its_owners_other_lists(self):
        data = snapshot()
        data.update(source_type="playlist", source_url="https://www.youtube.com/playlist?list=PLfixture")
        result, errors = self.run_enrich(data)
        self.assertFalse(any(kind == "channels" for _, kind in self.calls))
        self.assertEqual(result["playlists"][0]["id"], "PLfixture")
        self.assertEqual(errors, {})

    def test_empty_channel_playlist_listing_is_valid(self):
        original = self.fetch
        self.fetch = lambda url, kind: {"_type": "playlist", "entries": []} if kind == "channels" else original(url, kind)
        data, errors = self.run_enrich()
        self.assertEqual(data["playlists"], [])
        self.assertEqual(data["playlist_status"], "complete")
        self.assertEqual(errors, {})

    def test_explicitly_missing_playlists_tab_is_empty_but_network_failure_is_not(self):
        with patch("build_indexes.subprocess.run", return_value=subprocess.CompletedProcess([], 1, stdout="", stderr="ERROR: This channel does not have a playlists tab")):
            self.assertEqual(fetch_listing(SOURCE.replace("/videos", "/playlists"), "yt-dlp", 10)["entries"], [])
        with patch("build_indexes.subprocess.run", return_value=subprocess.CompletedProcess([], 1, stdout="", stderr="ERROR: Network failed")):
            with self.assertRaises(RuntimeError):
                fetch_listing(SOURCE.replace("/videos", "/playlists"), "yt-dlp", 10)

    def test_invalid_membership_is_not_cached_as_a_successful_playlist(self):
        archive = Archive(self.root, delay=0, fetch=lambda *args: {"_type": "playlist", "id": "PLfixture", "entries": [{"id": None, "title": "Unexpected"}]})
        with self.assertRaisesRegex(ValueError, "unexpected entry"):
            archive.get("playlists", "PLfixture", "https://www.youtube.com/playlist?list=PLfixture")
        self.assertFalse((self.root / "data/metadata/playlists/PLfixture.json").exists())

    def test_playlist_archive_retains_hidden_count_and_advisories(self):
        original = self.fetch
        def with_notices(url, kind):
            data = original(url, kind)
            if kind == "playlists":
                data.update(hidden_count=2, extraction_warnings=["2 unavailable videos are hidden"])
            return data
        self.fetch = with_notices
        data, errors = self.run_enrich()
        self.assertFalse(errors)
        self.assertEqual(data["playlists"][0]["hidden_count"], 2)
        archive = json.loads((self.root / "data/metadata/playlists/PLfixture.json").read_text())
        self.assertEqual(archive["hidden_count"], 2)
        self.assertEqual(archive["warnings"], ["2 unavailable videos are hidden"])

    def test_interruption_checkpoints_index_and_reuses_successful_video(self):
        original = self.fetch
        saved = []
        def interrupted(url, kind):
            if VIDEO_B in url:
                raise KeyboardInterrupt()
            return original(url, kind)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(KeyboardInterrupt):
            enrich_index(snapshot(), Archive(self.root, fetch=interrupted, delay=0), lambda data: saved.append(deepcopy(data)))
        self.assertEqual(saved[-1]["metadata_coverage"]["detailed"], 1)
        self.assertTrue((self.root / f"data/metadata/videos/{VIDEO_A}.json").exists())
        self.calls.clear()
        self.run_enrich(saved[-1])
        self.assertFalse(any(VIDEO_A in url for url, _ in self.calls))

    def test_refresh_keeps_real_observation_history_and_deduplicates_same_day(self):
        for day in ["2026-10-01", "2026-10-02", "2026-10-02"]:
            with patch("enrich_indexes.now", return_value=day + "T12:00:00+00:00"):
                self.archive(refresh=True).get("videos", VIDEO_A, f"https://www.youtube.com/watch?v={VIDEO_A}")
        archive = json.loads((self.root / f"data/metadata/videos/{VIDEO_A}.json").read_text())
        self.assertEqual([r["observed_at"][:10] for r in archive["observations"]], ["2026-10-01", "2026-10-02"])

    def test_dates_are_validated_and_flat_dates_are_not_mistaken_for_exact_dates(self):
        fields = {"upload_date": "20260230", "release_date": "20240229", "view_count": None, "like_count": -1}
        detailed = video_summary(fields, "2026-10-02T00:00:00Z", detailed=True)
        self.assertNotIn("upload_date", detailed)
        self.assertEqual(detailed["release_date"], "2024-02-29")
        self.assertNotIn("view_count", detailed)
        self.assertNotIn("like_count", detailed)
        self.assertNotIn("release_date", video_summary(fields, "2026-10-02T00:00:00Z"))

    def test_wrong_identity_does_not_poison_the_cache(self):
        archive = Archive(self.root, delay=0, fetch=lambda *args: {"id": VIDEO_B, "title": "Wrong"})
        with self.assertRaisesRegex(ValueError, "different video"):
            archive.get("videos", VIDEO_A, f"https://www.youtube.com/watch?v={VIDEO_A}")
        self.assertFalse((self.root / f"data/metadata/videos/{VIDEO_A}.json").exists())

    def test_video_metadata_accepts_format_warnings_without_downloading(self):
        info = {"id": VIDEO_A, "title": "Fixture", "upload_date": "20241001"}
        with patch("enrich_indexes.subprocess.run", return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(info), stderr="WARNING: No formats")) as run:
            result = fetch_video("https://www.youtube.com/watch?v=" + VIDEO_A, "yt-dlp", 100)
        self.assertIn("--ignore-config", run.call_args.args[0])
        self.assertIn("--skip-download", run.call_args.args[0])
        self.assertIn("--no-playlist", run.call_args.args[0])
        self.assertIn("metadata_warnings", result)

    def test_rate_limit_stops_the_run_instead_of_requesting_every_remaining_video(self):
        def blocked(*args):
            raise RuntimeError("HTTP Error 429: Too Many Requests")
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ExtractionBlocked):
            enrich_index(snapshot(), Archive(self.root, fetch=blocked, delay=0))

    def test_catalog_pipeline_bundles_enriched_data_that_browser_can_import(self):
        (self.root / "data").mkdir()
        item = {"id": "a" * 16, "name": "Fixture", "url": SOURCE}
        (self.root / "data/suggestions.json").write_text(json.dumps({"items": [item]}))
        with contextlib.redirect_stdout(io.StringIO()):
            build(self.root, fetcher=lambda _: snapshot(), preflight=lambda: None, delay=0)
            listing_report = (self.root / "data/index-build-report.json").read_bytes()
            report = enrich_catalog(self.root, archive=self.archive())
        self.assertEqual((self.root / "data/index-build-report.json").read_bytes(), listing_report)
        self.assertEqual(report["errors"], {})
        self.assertEqual(report["sources"][item["id"]]["dated"], 2)
        # Exercise the actual generated script and production normalizer together.
        core = Path(__file__).resolve().parents[1] / "core.js"
        program = """
          const fs = require('node:fs'), vm = require('node:vm');
          const Core = require(process.argv[1]); const context = {window: {}};
          vm.runInNewContext(fs.readFileSync(process.argv[2], 'utf8'), context);
          const data = Core.normalizeIndex(Object.values(context.window.DAILY_INDEXES)[0]);
          console.log(JSON.stringify([data.videos[0].upload_date, data.videos[0].like_count, data.playlists[0].video_ids]));
        """
        output = subprocess.check_output(["node", "-e", program, str(core), str(self.root / "data/indexes" / (item["id"] + ".js"))], text=True)
        self.assertEqual(json.loads(output), ["2024-02-29", 0, [VIDEO_A, FOREIGN, VIDEO_A]])

    def test_bundled_example_is_enriched_without_changing_daily_video_ids(self):
        (self.root / "data").mkdir()
        (self.root / "data/suggestions.json").write_text(json.dumps({"items": []}))
        (self.root / "data/geography-now.json").write_text(json.dumps(snapshot()))
        with contextlib.redirect_stdout(io.StringIO()):
            report = enrich_catalog(self.root, only="Fixture", archive=self.archive())
        saved = json.loads((self.root / "data/geography-now.json").read_text())
        self.assertEqual([v["id"] for v in saved["videos"]], [VIDEO_A, VIDEO_B])
        self.assertEqual(report["errors"], {})
        self.assertIn("window.DAILY_EXAMPLE =", (self.root / "library.js").read_text())


if __name__ == "__main__":
    unittest.main()
