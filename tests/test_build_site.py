import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from build_site import ASSETS, build_archives, build_site, prepare_output


class PublishingTests(unittest.TestCase):
    def test_site_preserves_index_and_rejects_changed_listing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "source"
            root.mkdir()
            for name in ASSETS:
                (root / name).write_text("")
            (root / "data/indexes").mkdir(parents=True)
            identity = "a" * 16
            data = {"version": 1, "source_type": "channel", "source_url": "https://www.youtube.com/@example/videos",
                    "source_title": "A channel", "fetched_at": "2026-11-01T00:00:00Z",
                    "videos": [{"id": "AA123456789", "title": "Geografía 🌎", "view_count": 0}]}
            (root / f"data/indexes/{identity}.json").write_text(json.dumps(data))
            report = {"version": 1, "items": {identity: {"status": "ready", "source_url": data["source_url"], "count": 1}}}
            report_path = root / "data/index-build-report.json"
            report_path.write_text(json.dumps(report))
            for name in ["metadata-build-report.json", "suggestions.json", "geography-now.json"]:
                (root / "data" / name).write_text("{}")
            output = Path(directory) / "site"
            result = build_site(root, output, "https://example.com/archives")
            self.assertEqual(result["sources"], 1)
            self.assertEqual(json.loads(gzip.decompress((output / f"data/indexes/{identity}.json.gz").read_bytes())), data)
            self.assertIn(f"data/indexes/{identity}.json.gz", (output / "indexes-manifest.js").read_text())
            self.assertIn("https://example.com/archives", (output / "site-config.js").read_text())
            report["items"][identity]["count"] = 2
            report_path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "changed during packaging"):
                build_site(root, output, "https://example.com/archives")

    def test_archive_keeps_all_fields_and_case_distinct_shards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "source"
            for kind in ["videos", "channels", "playlists"]:
                (root / "data/metadata" / kind).mkdir(parents=True)
            originals = {}
            for identity in ["AA123456789", "Aa987654321"]:
                archive = {"metadata": {"id": identity, "description": "All details 🌎", "thumbnails": [{"url": "https://example.com/image"}]},
                           "observations": [{"view_count": 0}, {"view_count": 12}]}
                originals[identity] = archive
                (root / f"data/metadata/videos/{identity}.json").write_text(json.dumps(archive))
            output = Path(directory) / "archive"
            result = build_archives(root, output, workers=2)
            self.assertEqual(result["video_shards"], 2)
            recovered = {}
            for path in (output / "videos").glob("*.gz"):
                recovered.update(json.loads(gzip.decompress(path.read_bytes())))
            self.assertEqual(recovered, originals)
            with self.assertRaises(ValueError):
                prepare_output(root, root)
            with self.assertRaises(ValueError):
                prepare_output(root / "data", root)


if __name__ == "__main__":
    unittest.main()
