from __future__ import annotations

import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import tidalapi_helper as helper


class PlaybackRemuxModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="puros-tidal-remux-")
        self.addCleanup(self.temporary.cleanup)
        self.output_dir = pathlib.Path(self.temporary.name)
        self.manifest = SimpleNamespace(
            codecs="FLAC", file_extension=".m4a", sample_rate=44100,
            get_urls=lambda: ["https://example.invalid/audio"],
        )
        self.media_stream = SimpleNamespace(track_id="42", sample_rate=44100, bit_depth=16)
        self.track = SimpleNamespace(id="42")

    def run_playback(self, *, host_remux: bool, legacy_extract):
        def download(_urls, destination, on_progress=None):
            destination.write_bytes(b"synthetic-container")
            if on_progress:
                on_progress(1.0)

        with (
            patch.object(helper, "load_session", return_value=object()),
            patch.object(helper, "resolve_best_playable_track", return_value=(self.track, self.media_stream, self.manifest, "LOSSLESS", [])),
            patch.object(helper, "merge_stream_urls_to_file", side_effect=download),
            patch.object(helper, "maybe_extract_flac", side_effect=legacy_extract) as extract,
            patch.object(helper, "session_snapshot", return_value={}),
            patch.object(helper, "describe_stream_format", return_value={"format": "FLAC"}),
            patch.object(helper, "emit"),
        ):
            result, _session = helper.cmd_playback_info({
                "session": {}, "trackId": "42", "outputDir": str(self.output_dir),
                "hostRemux": host_remux, "ffmpegPath": "/declared/ffmpeg" if not host_remux else None,
            })
        return result, extract

    def test_host_mode_returns_container_without_spawning_nested_ffmpeg(self):
        result, extract = self.run_playback(host_remux=True, legacy_extract=lambda *_args: self.fail("nested remux called"))
        self.assertTrue(result["hostRemux"])
        self.assertEqual(pathlib.Path(result["playbackPath"]).suffix, ".m4a")
        extract.assert_not_called()

    def test_legacy_mode_still_returns_remuxed_flac(self):
        def extract(source, _manifest, _ffmpeg_path):
            flac = source.with_suffix(".flac")
            flac.write_bytes(b"synthetic-flac")
            return flac

        result, called = self.run_playback(host_remux=False, legacy_extract=extract)
        self.assertFalse(result["hostRemux"])
        self.assertEqual(pathlib.Path(result["playbackPath"]).suffix, ".flac")
        called.assert_called_once()


if __name__ == "__main__":
    unittest.main()
