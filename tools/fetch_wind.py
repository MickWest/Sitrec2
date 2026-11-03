#!/usr/bin/env python3
"""Fetch GFS wind data from NOMADS and convert to JSON for Sitrec wind visualization.

Usage:
    python3 fetch_wind.py --date 20260412 --hour 00 --level surface --output /build/data/wind/
    python3 fetch_wind.py --date 20220919 --hour 18 --level 500     # 500 hPa (~18,000 ft)

Levels:
    surface  - 10m above ground (default)
    <number> - pressure level in hPa (e.g. 850, 700, 500, 300, 250, 200)

Output JSON format (earth.nullschool.net compatible):
    { "source": "GFS", "refTime": "...", "nx": 360, "ny": 181,
      "lon0": 0, "lat0": 90, "dlon": 1, "dlat": -1,
      "level": "10m", "u": [...], "v": [...] }
A pressure level also has "hgt": [...], the level's geopotential height in metres
at each grid point (GFS HGT). Sitrec puts the level at that height, not at its
standard-atmosphere height. Files written before 2026-11-03 have no "hgt".
"""

import argparse
import json
import os
import ssl
import struct
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta

# Build an SSL context that works under restricted environments (e.g. PHP/nginx
# on macOS) where the system certificate store isn't available.  Try certifi
# first; fall back to an unverified context so local-dev fetches don't break.
try:
    import certifi
    _ssl_ctx = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _ssl_ctx = ssl.create_default_context()
    # If the default context can't find system certs either, allow unverified
    # (acceptable for fetching public NOAA weather data in local dev).
    _ssl_ctx.check_hostname = False
    _ssl_ctx.verify_mode = ssl.CERT_NONE

PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10]

# Approximate altitude in feet for each pressure level
LEVEL_ALT_FT = {
    1000: 360, 975: 1000, 950: 1640, 925: 2500, 900: 3280,
    850: 4780, 800: 6400, 700: 9880, 600: 13800, 500: 18300,
    400: 23600, 300: 30000, 250: 33800, 200: 38600, 150: 44600,
    100: 53200, 70: 60700, 50: 67500, 30: 78100, 20: 86900, 10: 101000,
}


def build_nomads_url(date, hour, level, resolution="1p00"):
    """Build NOMADS GFS GRIB filter URL."""
    base = f"https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_{resolution}.pl"

    if level == "surface":
        lev_param = "lev_10_m_above_ground=on"
    else:
        lev_param = f"lev_{level}_mb=on"

    # A pressure level also gets its geopotential height (HGT).
    hgt_param = "" if level == "surface" else "&var_HGT=on"
    params = (
        f"file=gfs.t{hour:02d}z.pgrb2.{resolution}.f000"
        f"&{lev_param}"
        f"&var_UGRD=on&var_VGRD=on{hgt_param}"
        f"&dir=%2Fgfs.{date}%2F{hour:02d}%2Fatmos"
    )
    return f"{base}?{params}"


def build_aws_url(date, hour, resolution="1p00"):
    """Build AWS S3 URL for historical GFS data."""
    return (
        f"https://noaa-gfs-bdp-pds.s3.amazonaws.com/"
        f"gfs.{date}/{hour:02d}/atmos/gfs.t{hour:02d}z.pgrb2.{resolution}.f000"
    )


def download_grib(url, output_path):
    """Download a GRIB2 file."""
    print(f"Downloading: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Sitrec-Wind/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60, context=_ssl_ctx) as resp:
            data = resp.read()
            with open(output_path, "wb") as f:
                f.write(data)
            print(f"Downloaded {len(data)} bytes to {output_path}")
            return True
    except urllib.error.HTTPError as e:
        print(f"HTTP error {e.code}: {e.reason}")
        return False
    except Exception as e:
        print(f"Download failed: {e}")
        return False


def download_from_aws_idx(date, hour, level, resolution="1p00"):
    """Download wind variables from AWS S3 using byte-range requests via the .idx index file."""
    base_url = build_aws_url(date, hour, resolution)
    idx_url = base_url + ".idx"

    # Build the grep pattern for the level we want
    if level == "surface":
        level_pattern = "10 m above ground"
    else:
        level_pattern = f"{level} mb"

    print(f"Fetching index: {idx_url}")
    try:
        req = urllib.request.Request(idx_url, headers={"User-Agent": "Sitrec-Wind/1.0"})
        with urllib.request.urlopen(req, timeout=30, context=_ssl_ctx) as resp:
            idx_text = resp.read().decode("utf-8")
    except Exception as e:
        print(f"Failed to fetch index: {e}")
        return None

    # Parse index to find byte ranges for UGRD and VGRD at our level, and HGT
    # for a pressure level
    wanted = ("UGRD", "VGRD") if level == "surface" else ("UGRD", "VGRD", "HGT")
    lines = idx_text.strip().split("\n")
    ranges = []  # (start, end, var_name)

    for i, line in enumerate(lines):
        parts = line.split(":")
        if len(parts) < 5:
            continue
        var_name = parts[3]
        var_level = parts[4]

        if var_name in wanted and var_level == level_pattern:
            start_byte = int(parts[1])
            # End byte is the start of the next record minus 1
            if i + 1 < len(lines):
                next_parts = lines[i + 1].split(":")
                end_byte = int(next_parts[1]) - 1
            else:
                end_byte = ""  # To end of file
            ranges.append((start_byte, end_byte, var_name))

    if len(ranges) < 2:
        print(f"Could not find UGRD/VGRD for level '{level_pattern}' in index")
        return None

    # Download the byte ranges and concatenate
    grib_data = b""
    for start, end, var in ranges:
        range_str = f"bytes={start}-{end}" if end else f"bytes={start}-"
        print(f"  Fetching {var} at {level_pattern}: {range_str}")
        req = urllib.request.Request(base_url, headers={
            "User-Agent": "Sitrec-Wind/1.0",
            "Range": range_str,
        })
        try:
            with urllib.request.urlopen(req, timeout=60, context=_ssl_ctx) as resp:
                chunk = resp.read()
                grib_data += chunk
                print(f"    Got {len(chunk)} bytes")
        except Exception as e:
            print(f"    Failed: {e}")
            return None

    # Write concatenated GRIB2 messages
    output_path = f"/tmp/gfs_{date}_{hour:02d}z_{level}_aws.grib2"
    with open(output_path, "wb") as f:
        f.write(grib_data)
    print(f"Wrote {len(grib_data)} bytes to {output_path}")
    return output_path


def parse_grib2(filepath, target_level="surface"):
    """Parse GRIB2 file and extract U/V wind grids (and the geopotential height
    of a pressure level, if the file has it) using eccodes."""
    import eccodes

    u_data = None
    v_data = None
    hgt_data = None
    grid_info = {}

    with open(filepath, "rb") as f:
        while True:
            msgid = eccodes.codes_grib_new_from_file(f)
            if msgid is None:
                break

            try:
                short_name = eccodes.codes_get(msgid, "shortName")
                level_type = eccodes.codes_get(msgid, "typeOfLevel")
                level = eccodes.codes_get(msgid, "level")

                # Check if this is the level we want
                if target_level == "surface":
                    if level_type != "heightAboveGround" or level != 10:
                        continue
                else:
                    target_hpa = int(target_level)
                    if level_type != "isobaricInhPa" or level != target_hpa:
                        continue

                nx = eccodes.codes_get(msgid, "Ni")
                ny = eccodes.codes_get(msgid, "Nj")
                lat1 = eccodes.codes_get(msgid, "latitudeOfFirstGridPointInDegrees")
                lon1 = eccodes.codes_get(msgid, "longitudeOfFirstGridPointInDegrees")
                lat2 = eccodes.codes_get(msgid, "latitudeOfLastGridPointInDegrees")
                lon2 = eccodes.codes_get(msgid, "longitudeOfLastGridPointInDegrees")
                dlat = eccodes.codes_get(msgid, "jDirectionIncrementInDegrees")
                dlon = eccodes.codes_get(msgid, "iDirectionIncrementInDegrees")
                scan_j_pos = eccodes.codes_get(msgid, "jScansPositively")

                grid_info = {
                    "nx": nx, "ny": ny,
                    "lon0": lon1, "lat0": lat1,
                    "dlon": dlon,
                    "dlat": -dlat if not scan_j_pos else dlat,
                }

                values = eccodes.codes_get_values(msgid)

                if short_name == "10u" or short_name == "u":
                    u_data = values
                    print(f"Got U wind: {nx}x{ny}, level={level} {level_type}, range [{values.min():.1f}, {values.max():.1f}] m/s")
                elif short_name == "10v" or short_name == "v":
                    v_data = values
                    print(f"Got V wind: {nx}x{ny}, level={level} {level_type}, range [{values.min():.1f}, {values.max():.1f}] m/s")
                elif short_name == "gh":
                    hgt_data = values
                    print(f"Got height: {nx}x{ny}, level={level} {level_type}, range [{values.min():.0f}, {values.max():.0f}] m")

            finally:
                eccodes.codes_release(msgid)

    return u_data, v_data, hgt_data, grid_info


def fetch_pressure_level_grib(date, hour, level_hpa, output_dir="/tmp"):
    """Fetch a specific pressure level from NOMADS."""
    grib_path = os.path.join(output_dir, f"gfs_{date}_{hour:02d}z_{level_hpa}hPa.grib2")

    url = build_nomads_url(date, hour, str(level_hpa))
    if not download_grib(url, grib_path):
        # Try AWS S3 for historical data (full file, needs filtering)
        print(f"NOMADS failed, trying AWS S3...")
        # For AWS we'd need the full file and filter - skip for now
        return None

    return grib_path


def main():
    parser = argparse.ArgumentParser(description="Fetch GFS wind data for Sitrec")
    parser.add_argument("--date", required=True, help="Date YYYYMMDD")
    parser.add_argument("--hour", type=int, default=0, help="Model run hour (0, 6, 12, 18)")
    parser.add_argument("--level", default="surface",
                        help="'surface' for 10m winds, or pressure in hPa (e.g. 500)")
    parser.add_argument("--output", default="/build/data/wind/",
                        help="Output directory for JSON files")
    parser.add_argument("--resolution", default="1p00",
                        help="Grid resolution: 0p25, 0p50, 1p00")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    # Round hour to nearest 6-hour GFS cycle
    cycle_hour = (args.hour // 6) * 6

    # Build list of cycles to try: requested cycle, then earlier ones on the same day
    cycles_to_try = [cycle_hour]
    for h in range(cycle_hour - 6, -1, -6):
        cycles_to_try.append(h)

    # Download GRIB2 — try each cycle, NOMADS first then AWS S3 fallback
    grib_path = None
    for try_hour in cycles_to_try:
        candidate = f"/tmp/gfs_{args.date}_{try_hour:02d}z_{args.level}.grib2"
        url = build_nomads_url(args.date, try_hour, args.level, args.resolution)

        if download_grib(url, candidate):
            grib_path = candidate
            cycle_hour = try_hour
            break
        else:
            print(f"NOMADS {try_hour:02d}Z not available, trying AWS S3...")
            aws_path = download_from_aws_idx(args.date, try_hour, args.level, args.resolution)
            if aws_path:
                grib_path = aws_path
                cycle_hour = try_hour
                break

    if grib_path is None:
        print(f"All cycles failed for {args.date}.")
        sys.exit(1)

    # Parse GRIB2
    u_data, v_data, hgt_data, grid_info = parse_grib2(grib_path, args.level)

    if u_data is None or v_data is None:
        print("Failed to extract U/V wind components")
        sys.exit(1)

    # Build output JSON
    level_str = "10m" if args.level == "surface" else f"{args.level}hPa"
    ref_time = f"{args.date[:4]}-{args.date[4:6]}-{args.date[6:8]}T{cycle_hour:02d}:00:00Z"

    result = {
        "source": "GFS",
        "refTime": ref_time,
        "level": level_str,
        **grid_info,
        "u": [round(float(x), 2) for x in u_data],
        "v": [round(float(x), 2) for x in v_data],
    }
    # The level's height at each point, to the metre (a pressure level only;
    # without it Sitrec uses the standard-atmosphere height).
    if hgt_data is not None and len(hgt_data) == len(u_data):
        result["hgt"] = [int(round(float(x))) for x in hgt_data]

    out_file = os.path.join(args.output, f"wind_{args.date}_{cycle_hour:02d}z_{level_str}.json")
    with open(out_file, "w") as f:
        json.dump(result, f, separators=(",", ":"))

    file_size = os.path.getsize(out_file)
    print(f"\nWrote {out_file} ({file_size:,} bytes)")
    print(f"Grid: {grid_info['nx']}x{grid_info['ny']}, level: {level_str}")

    # Clean up GRIB
    os.remove(grib_path)

    return out_file


if __name__ == "__main__":
    main()
