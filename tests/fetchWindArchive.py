"""Exercise archive selection and byte ranges without NOAA access or eccodes."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("fetch_wind", Path(__file__).resolve().parents[1] / "tools/fetch_wind.py")
wind = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wind)


class WindArchiveTests(unittest.TestCase):
    def test_ncei_pressure_records_include_height(self):
        inventory = (
            "1:0:d=2020123006:TMP:500 mb:anl:\n"
            "2:10:d=2020123006:HGT:500 mb:anl:\n"
            "3:20:d=2020123006:UGRD:500 mb:anl:\n"
            "4:30:d=2020123006:VGRD:500 mb:anl:\n"
            "5:40:d=2020123006:UGRD:700 mb:anl:\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "level.grib2"
            # Keep the downloader's temporary file inside this test's fixture.
            with patch("builtins.open", side_effect=lambda *args: target.open("wb")), \
                    patch.object(wind.urllib.request, "urlopen", side_effect=[
                        io.BytesIO(inventory.encode()), io.BytesIO(b"height"),
                        io.BytesIO(b"east"), io.BytesIO(b"north"),
                    ]) as fetch:
                wind.download_from_ncei("20201230", 6, "500")
            self.assertEqual(target.read_bytes(), b"heighteastnorth")
            requests = [call.args[0] for call in fetch.call_args_list]
            self.assertEqual(requests[0].full_url,
                "https://www.ncei.noaa.gov/oa/prod-model/global-forecast-system/access/"
                "grid-003-1.0-degree/analysis/202012/20201230/gfs_3_20201230_0600_000.grb2.inv")
            self.assertEqual([r.get_header("Range") for r in requests[1:]],
                ["bytes=10-19", "bytes=20-29", "bytes=30-39"])

    def test_missing_wind_component_is_not_a_grid(self):
        inventory = "1:0:d=2020123006:HGT:500 mb:anl:\n2:10:d=2020123006:UGRD:500 mb:anl:\n"
        with patch.object(wind.urllib.request, "urlopen", return_value=io.BytesIO(inventory.encode())) as fetch:
            self.assertIsNone(wind.download_from_ncei("20201230", 6, "500"))
            self.assertEqual(fetch.call_count, 1)

    def test_archive_routing_and_output_time(self):
        for date, hour, expected in [("20201230", 6, "ncei"), ("20210322", 6, "ncei"),
                                     ("20210322", 12, "aws"), ("20250919", 18, "aws")]:
            with self.subTest(date=date, hour=hour), tempfile.TemporaryDirectory() as directory:
                grib = Path(directory) / "fixture.grib2"
                grib.write_bytes(b"fixture")
                with patch.object(wind.sys, "argv", ["fetch_wind.py", "--date", date,
                        "--hour", str(hour), "--level", "500", "--output", directory]), \
                        patch.object(wind, "download_from_ncei", return_value=str(grib)) as ncei, \
                        patch.object(wind, "download_grib", return_value=False) as nomads, \
                        patch.object(wind, "download_from_aws_idx", return_value=str(grib)) as aws, \
                        patch.object(wind, "parse_grib2", return_value=([1.25], [-2.5], [5500], {"nx": 1, "ny": 1})):
                    result = json.loads(Path(wind.main()).read_text())
                self.assertEqual(ncei.call_count, int(expected == "ncei"))
                self.assertEqual(aws.call_count, int(expected == "aws"))
                self.assertEqual(nomads.call_count, int(expected == "aws"))
                self.assertEqual(result["refTime"], f"{date[:4]}-{date[4:6]}-{date[6:]}T{hour:02d}:00:00Z")
                self.assertEqual(result["source"], "GFS")
                self.assertEqual(result["hgt"], [5500])


if __name__ == "__main__":
    unittest.main()
