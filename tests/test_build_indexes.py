import contextlib
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from build_indexes import build, extract, listing_warnings
from daily_video import normalize_source


def snapshot(url, count=2):
    return {
        "version": 1, "source_url": url, "source_type": "channel",
        "source_title": "Fixture channel", "channel_id": "UC" + "x" * 22,
        "fetched_at": "2026-10-01T12:00:00+00:00",
        "videos": [{"id": f"{number:011d}", "title": f"Video {number}"} for number in range(count)],
    }


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "data").mkdir()
        self.items = [
            {"id": "0" * 16, "name": "First", "url": "https://www.youtube.com/@first"},
            {"id": "1" * 16, "name": "Second", "url": "https://www.youtube.com/@second"},
            {"id": "2" * 16, "name": "Unknown", "url": None},
        ]
        (self.root / "data/suggestions.json").write_text(json.dumps({"items": self.items}))

    def run_build(self, **kwargs):
        options = {"fetcher": snapshot, "preflight": lambda: None, "delay": 0, **kwargs}
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return build(self.root, **options)

    def report(self):
        return json.loads((self.root / "data/index-build-report.json").read_text())

    def test_resume_skips_complete_sources_and_records_unknowns(self):
        self.run_build()
        self.assertEqual(self.report()["counts"], {"ready": 2, "missing_url": 1})
        def unexpected(_):
            raise AssertionError("A completed snapshot must not be fetched again")
        self.run_build(fetcher=unexpected)
        self.assertIn("window.DAILY_INDEXES[", (self.root / "data/indexes" / ("0" * 16 + ".js")).read_text())

    def test_failed_refresh_keeps_previous_snapshot(self):
        self.run_build()
        path = self.root / "data/indexes" / ("0" * 16 + ".json")
        before = path.read_bytes()
        def broken(_):
            raise RuntimeError("Continuation page failed")
        self.run_build(refresh=True, fetcher=broken)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.report()["items"]["0" * 16]["status"], "ready")
        self.assertIn("Continuation", self.report()["errors"]["0" * 16])

    def test_first_time_failure_is_not_published_as_empty_or_partial(self):
        def broken(_):
            raise RuntimeError("Continuation page failed")
        self.run_build(fetcher=broken)
        self.assertEqual(self.report()["counts"], {"failed": 2, "missing_url": 1})
        self.assertFalse((self.root / "data/indexes").exists())

    def test_interrupt_checkpoints_successes(self):
        def interrupted(url):
            if "second" in url:
                raise KeyboardInterrupt()
            return snapshot(url)
        with self.assertRaises(KeyboardInterrupt):
            self.run_build(fetcher=interrupted)
        self.assertEqual(self.report()["counts"], {"ready": 1, "pending": 1, "missing_url": 1})

    def test_network_block_marks_unattempted_sources_pending(self):
        def offline():
            raise socket.gaierror("DNS unavailable")
        with self.assertRaisesRegex(RuntimeError, "DNS unavailable"):
            self.run_build(preflight=offline)
        self.assertEqual(self.report()["counts"], {"pending": 2, "missing_url": 1})
        self.assertIn("DNS unavailable", self.report()["fatal_error"])

    def test_wrong_source_or_invalid_entries_are_never_published(self):
        self.run_build(fetcher=lambda url: snapshot("https://www.youtube.com/@wrong/videos"))
        self.assertEqual(self.report()["counts"]["failed"], 2)
        self.assertFalse((self.root / "data/indexes").exists())

    def test_only_filter_does_not_hide_other_sources(self):
        self.run_build(only="First")
        self.assertEqual(self.report()["total"], 3)
        self.assertEqual(self.report()["counts"], {"ready": 1, "pending": 1, "missing_url": 1})

    def test_extraction_ignores_personal_config_and_filters_shorts_and_live(self):
        info = {"_type": "playlist", "channel": "Sample", "entries": [
            {"id": "00000000000", "title": "Keep"},
            {"id": "11111111111", "url": "https://youtube.com/shorts/11111111111"},
            {"id": "22222222222", "live_status": "was_live"},
            {"id": "33333333333", "title": "[Private video]"},
            {"id": "00000000000", "title": "Duplicate"},
        ]}
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps(info), stderr="")
        with patch("build_indexes.subprocess.run", return_value=result) as run:
            data = extract(normalize_source("@first"), "yt-dlp", 10)
        command = run.call_args.args[0]
        self.assertIn("--ignore-config", command)
        self.assertIn("youtube:raise_incomplete_data=true", command)
        self.assertNotIn("--playlist-end", command)
        self.assertEqual([video["id"] for video in data["videos"]], ["00000000000"])
        with patch("build_indexes.subprocess.run", return_value=result):
            data = extract("https://www.youtube.com/playlist?list=PLtest", "yt-dlp", 10)
        self.assertEqual(len(data["videos"]), 3)

    def test_failed_process_discards_even_parseable_partial_stdout(self):
        result = subprocess.CompletedProcess([], 1, stdout=json.dumps({"_type": "playlist", "entries": [{"id": "00000000000"}]}), stderr="Network failure")
        with patch("build_indexes.subprocess.run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "Network failure"):
                extract(normalize_source("@first"), "yt-dlp", 10)

    def test_warning_with_success_exit_does_not_publish_partial_listing(self):
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps({"_type": "playlist", "entries": [{"id": "00000000000"}]}), stderr="WARNING: Unable to download API page")
        with patch("build_indexes.subprocess.run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "snapshot not replaced"):
                extract(normalize_source("@first"), "yt-dlp", 10)

    def test_old_version_advisory_does_not_discard_a_successful_listing(self):
        warning = ("WARNING: Your yt-dlp version (2026.07.04) is older than 90 days!\n"
                   "         It is strongly recommended to always use the latest version.\n"
                   "         You installed yt-dlp with pip or using the wheel from PyPi; Use that to update.\n"
                   "         To suppress this warning, add --no-update to your command/config.\n")
        info = {"_type": "playlist", "channel": "Fixture", "entries": [{"id": "00000000000", "title": "Keep"}]}
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps(info), stderr=warning)
        with patch("build_indexes.subprocess.run", return_value=result):
            data = extract(normalize_source("@first"), "yt-dlp", 10)
        self.assertEqual(len(data["videos"]), 1)
        self.assertEqual(len(data["extraction_warnings"]), 1)
        self.assertIn("older than 90 days", data["extraction_warnings"][0])

    def test_old_version_plus_continuation_warning_still_rejects_partial_results(self):
        info = {"_type": "playlist", "entries": [{"id": "00000000000"}]}
        for failure in ["[youtube:tab] Incomplete yt initial data received", "Unable to download API page", 'Unsupported lockup view model content type "LOCKUP_CONTENT_TYPE_COURSE"', "An unknown extractor warning"]:
            result = subprocess.CompletedProcess([], 0, stdout=json.dumps(info), stderr=
                "WARNING: Your yt-dlp version (2026.07.04) is older than 90 days!\nWARNING: " + failure)
            with self.subTest(failure=failure), patch("build_indexes.subprocess.run", return_value=result):
                with self.assertRaisesRegex(RuntimeError, "snapshot not replaced"):
                    extract(normalize_source("@first"), "yt-dlp", 10)

    def test_hidden_videos_notice_saves_visible_playlist_entries_and_hidden_count(self):
        warning = "WARNING: [youtube:tab] YouTube said: INFO - 2 unavailable videos are hidden\n"
        info = {"_type": "playlist", "title": "Fixture", "entries": [{"id": "00000000000", "title": "Visible"}]}
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps(info), stderr=warning * 2)
        with patch("build_indexes.subprocess.run", return_value=result):
            data = extract("https://www.youtube.com/playlist?list=PLfixture", "yt-dlp", 10)
        self.assertEqual(len(data["videos"]), 1)
        self.assertEqual(data["hidden_count"], 2)
        self.assertEqual(len(data["extraction_warnings"]), 2)

    def test_error_on_success_exit_and_colored_warnings_are_not_overlooked(self):
        warnings, blocked, hidden = listing_warnings("\x1b[0;33mWARNING:\x1b[0m Unable to download API page\nERROR: Extraction failed\n")
        self.assertEqual(blocked, ["Unable to download API page", "Extraction failed"])
        self.assertEqual(hidden, 0)
        self.assertEqual(warnings, ["Unable to download API page"])


if __name__ == "__main__":
    unittest.main()
