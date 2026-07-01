#!/usr/bin/env python3
"""
Native Local Compute worker for Sitrec Motion Analysis.

The browser-side MotionAnalyzer is the compatibility contract: this worker emits
resultCache/duplicateFrameCache-compatible JSON so Sitrec can keep using the
existing overlay, graph, panorama, stabilization, and track export paths.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import ssl
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np


MOTION_TECHNIQUES = {
    "SPARSE_CONSENSUS": "Sparse + Consensus",
    "LINEAR_TRACKLET": "Linear Tracklet",
    "PHASE_CORRELATION": "Phase Correlation",
    "ECC_EUCLIDEAN": "ECC Euclidean",
    "AFFINE_RANSAC": "Affine RANSAC",
}

DUPLICATE_IDENTICAL_RATIO = 0.93
DUPLICATE_MEAN_ABS_DIFF = 0.15


def json_safe(value):
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_safe(v) for v in value]
    if isinstance(value, tuple):
        return [json_safe(v) for v in value]
    if isinstance(value, np.generic):
        return json_safe(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def emit(payload: dict) -> None:
    print(json.dumps(json_safe(payload), separators=(",", ":"), allow_nan=False), flush=True)


def finite(value, fallback=0.0):
    try:
        v = float(value)
        return v if math.isfinite(v) else fallback
    except Exception:
        return fallback


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def angle(dx, dy):
    return math.atan2(dy, dx)


def magnitude(dx, dy):
    return math.sqrt(dx * dx + dy * dy)


def normalize_technique(value):
    if value in MOTION_TECHNIQUES.values():
        return value
    return MOTION_TECHNIQUES.get(str(value), MOTION_TECHNIQUES["LINEAR_TRACKLET"])


def safe_unlink(path):
    try:
        os.unlink(path)
    except Exception:
        pass


class VideoSource:
    def __init__(self, source, video_speed=1.0, rotation=0, target_width=None, target_height=None):
        self.original_source = source
        self.source = self._materialize_source(source)
        self.video_speed = max(0.0001, finite(video_speed, 1.0))
        self.rotation = int(rotation or 0) % 360
        self.target_width = int(target_width) if target_width else None
        self.target_height = int(target_height) if target_height else None
        self.cap = cv2.VideoCapture(self.source)
        if not self.cap.isOpened():
            raise RuntimeError(f"OpenCV could not open video source: {source}")
        self.last_actual_frame = None
        self.decode_count = 0
        self.seek_count = 0
        self.resize_count = 0
        self.read_seconds = 0.0
        self.resize_seconds = 0.0

    def close(self):
        try:
            self.cap.release()
        except Exception:
            pass

    def _materialize_source(self, source):
        if not source:
            raise RuntimeError("No video source URL/path supplied")

        parsed = urllib.parse.urlparse(source)
        if parsed.scheme in ("http", "https"):
            cache_dir = Path(tempfile.gettempdir()) / "sitrec-local-compute-cache"
            cache_dir.mkdir(parents=True, exist_ok=True)
            suffix = Path(parsed.path).suffix or ".video"
            digest = hashlib.sha256(source.encode("utf-8")).hexdigest()[:24]
            target = cache_dir / f"{digest}{suffix}"
            if target.exists() and target.stat().st_size > 0:
                emit({"type": "progress", "progress": {"phase": "download", "current": 1, "total": 1, "pct": 100, "cached": True}})
                return str(target)

            emit({"type": "progress", "progress": {"phase": "download", "current": 0, "total": 1, "pct": 0}})
            context = None
            if parsed.hostname in ("localhost", "127.0.0.1", "local.metabunk.org"):
                context = ssl._create_unverified_context()

            tmp = str(target) + ".part"
            req = urllib.request.Request(source, headers={"User-Agent": "SitrecLocalCompute/1.0"})
            with urllib.request.urlopen(req, timeout=60, context=context) as response:
                total = int(response.headers.get("Content-Length") or "0")
                done = 0
                last_emit = 0.0
                with open(tmp, "wb") as out:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        done += len(chunk)
                        now = time.time()
                        if now - last_emit > 0.25:
                            pct = int(100 * done / total) if total else 0
                            emit({"type": "progress", "progress": {"phase": "download", "current": done, "total": total or 1, "pct": pct}})
                            last_emit = now
            os.replace(tmp, target)
            emit({"type": "progress", "progress": {"phase": "download", "current": 1, "total": 1, "pct": 100}})
            return str(target)

        if parsed.scheme == "file":
            return urllib.request.url2pathname(parsed.path)
        return source

    def actual_frame(self, virtual_frame):
        return int(math.floor(virtual_frame / self.video_speed))

    def read_bgr(self, virtual_frame):
        t0 = time.perf_counter()
        actual = self.actual_frame(virtual_frame)
        if actual < 0:
            return None
        if self.last_actual_frame is None or actual != self.last_actual_frame + 1:
            self.seek_count += 1
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, actual)
        ok, frame = self.cap.read()
        if not ok or frame is None:
            # Some backends dislike exact seeks on remote/cache files; retry once.
            self.seek_count += 1
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, actual)
            ok, frame = self.cap.read()
        if not ok or frame is None:
            return None
        self.decode_count += 1
        self.last_actual_frame = actual
        if self.rotation == 90:
            frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
        elif self.rotation == 180:
            frame = cv2.rotate(frame, cv2.ROTATE_180)
        elif self.rotation == 270:
            frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
        if self.target_width and self.target_height:
            h, w = frame.shape[:2]
            if w != self.target_width or h != self.target_height:
                rt0 = time.perf_counter()
                interpolation = cv2.INTER_AREA if self.target_width * self.target_height < w * h else cv2.INTER_LINEAR
                frame = cv2.resize(frame, (self.target_width, self.target_height), interpolation=interpolation)
                self.resize_count += 1
                self.resize_seconds += time.perf_counter() - rt0
        self.read_seconds += time.perf_counter() - t0
        return frame


class MotionAnalyzerLocal:
    def __init__(self, request):
        self.request = request
        params = dict(request.get("params") or {})
        params.setdefault("technique", MOTION_TECHNIQUES["LINEAR_TRACKLET"])
        params["technique"] = normalize_technique(params.get("technique"))
        self.params = params
        self.video_speed = finite(request.get("videoSpeed"), 1.0)
        self.a_frame = int(request.get("startFrame", 0))
        self.b_frame = int(request.get("endFrame", request.get("frames", 1) - 1))
        self.total_frames = max(1, int(request.get("frames", self.b_frame + 1)))
        self.video = VideoSource(
            request.get("sourceUrl") or request.get("source") or request.get("fileName"),
            video_speed=self.video_speed,
            rotation=request.get("effectiveRotation") or request.get("rotation") or 0,
            target_width=finite(request.get("targetWidth"), 0),
            target_height=finite(request.get("targetHeight"), 0),
        )
        self.gray_cache = OrderedDict()
        self.gray_frame_bytes = self._gray_frame_bytes()
        self.gray_cache_limit = self._default_gray_cache_limit(request)
        self.gray_cache_hits = 0
        self.gray_cache_misses = 0
        self.duplicate_cache = {}
        self.result_cache = {}
        self.static_history = {}
        self.angle_history = []
        self.max_history_length = 300
        self.smoothed_direction = {"x": 0, "y": 0, "angle": 0, "magnitude": 0, "confidence": 0, "rotation": 0}
        self.last_flow_data = None
        self.mask = self._decode_mask(request.get("maskData"))

    def _gray_frame_bytes(self):
        width = self.video.target_width
        height = self.video.target_height
        if not width or not height:
            width = int(self.video.cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(self.video.cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            if self.video.rotation in (90, 270):
                width, height = height, width
        if width > 0 and height > 0:
            return max(1, width * height)
        return 1280 * 720

    def _default_gray_cache_limit(self, request):
        explicit = request.get("grayCacheLimit")
        if explicit is not None:
            return max(8, int(finite(explicit, 96)))

        skip = max(1, int(round(finite(self.p("frameSkip", 3), 3))))
        if self.p("skipDuplicateFrames", True):
            scan_start = max(1, self.a_frame - max(skip * 10, 30))
        else:
            scan_start = max(1, self.a_frame - skip)
        needed = max(96, self.b_frame - scan_start + 1 + skip + 2)

        hard_limit = os.environ.get("SITREC_LOCAL_COMPUTE_GRAY_CACHE_LIMIT")
        if hard_limit:
            try:
                cap = int(hard_limit)
            except Exception:
                cap = 512
        else:
            try:
                cache_mb = finite(os.environ.get("SITREC_LOCAL_COMPUTE_GRAY_CACHE_MB", "1024"), 1024)
            except Exception:
                cache_mb = 1024
            budget_bytes = max(96 * self.gray_frame_bytes, int(cache_mb * 1024 * 1024))
            cap = max(96, budget_bytes // self.gray_frame_bytes)
        return min(needed, cap)

    def close(self):
        self.video.close()

    def p(self, key, fallback):
        return self.params.get(key, fallback)

    def _decode_mask(self, mask_data):
        if not mask_data or not isinstance(mask_data, str):
            return None
        try:
            data = mask_data.split(",", 1)[1] if "," in mask_data else mask_data
            raw = base64.b64decode(data)
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
            if img is None:
                return None
            if len(img.shape) == 3 and img.shape[2] >= 4:
                return img[:, :, 3] > 128
            if len(img.shape) == 2:
                return img > 128
        except Exception as exc:
            print(f"[local-compute] could not decode mask: {exc}", file=sys.stderr)
        return None

    def is_point_masked(self, x, y):
        if self.mask is None:
            return False
        h, w = self.mask.shape[:2]
        ix = int(round(x))
        iy = int(round(y))
        if ix < 0 or ix >= w or iy < 0 or iy >= h:
            return False
        return bool(self.mask[iy, ix])

    def read_gray(self, frame):
        frame = int(frame)
        if frame in self.gray_cache:
            self.gray_cache_hits += 1
            gray = self.gray_cache.pop(frame)
            self.gray_cache[frame] = gray
            return gray

        self.gray_cache_misses += 1
        bgr = self.video.read_bgr(frame)
        if bgr is None:
            return None
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        blur = int(self.p("blurSize", 5)) | 1
        if blur > 1:
            gray = cv2.GaussianBlur(gray, (blur, blur), 0)
        self.gray_cache[frame] = gray
        while len(self.gray_cache) > self.gray_cache_limit:
            self.gray_cache.popitem(last=False)
        return gray

    def compare_gray_for_duplicate(self, gray_a, gray_b):
        if gray_a is None or gray_b is None or gray_a.shape != gray_b.shape:
            return {"isDuplicate": False, "identicalRatio": 0, "meanAbsDiff": float("inf")}
        a = gray_a.reshape(-1)
        b = gray_b.reshape(-1)
        n = min(a.size, b.size)
        if n == 0:
            return {"isDuplicate": False, "identicalRatio": 0, "meanAbsDiff": float("inf")}
        stride = max(1, n // 50000)
        aa = a[:n:stride].astype(np.int16)
        bb = b[:n:stride].astype(np.int16)
        diff = np.abs(aa - bb)
        identical_ratio = float(np.count_nonzero(diff == 0) / diff.size)
        mean_abs_diff = float(diff.mean()) if diff.size else float("inf")
        return {
            "isDuplicate": identical_ratio >= DUPLICATE_IDENTICAL_RATIO and mean_abs_diff <= DUPLICATE_MEAN_ABS_DIFF,
            "identicalRatio": identical_ratio,
            "meanAbsDiff": mean_abs_diff,
        }

    def detect_duplicate_frame(self, frame, gray):
        if not self.p("skipDuplicateFrames", True) or frame <= 0:
            result = {"isDuplicate": False, "identicalRatio": 0, "meanAbsDiff": float("inf")}
            self.duplicate_cache[frame] = result
            return result
        if frame in self.duplicate_cache:
            return self.duplicate_cache[frame]
        prev_gray = self.read_gray(frame - 1)
        result = self.compare_gray_for_duplicate(prev_gray, gray)
        self.duplicate_cache[frame] = result
        return result

    def get_prior_analysis_frame(self, frame, skip_frames):
        if not self.p("skipDuplicateFrames", True):
            return frame - skip_frames
        remaining = skip_frames
        for f in range(frame - 1, -1, -1):
            duplicate_info = self.duplicate_cache.get(f)
            if duplicate_info and duplicate_info.get("isDuplicate"):
                continue
            remaining -= 1
            if remaining == 0:
                return f
        return -1

    def get_tracklet_source_frames(self, frame, skip_frames):
        if not self.p("skipDuplicateFrames", True):
            start = frame - skip_frames
            if start < 0:
                return None
            return list(range(start, frame + 1))

        frames = []
        for f in range(frame, -1, -1):
            duplicate_info = self.duplicate_cache.get(f)
            if duplicate_info and duplicate_info.get("isDuplicate"):
                continue
            frames.append(f)
            if len(frames) >= skip_frames + 1:
                break
        if len(frames) < skip_frames + 1:
            return None
        return list(reversed(frames))

    def make_zero_motion_flow_data(self, is_duplicate=False):
        return {
            "vectors": [],
            "consensus": {"dx": 0, "dy": 0, "confidence": 1, "inlierCount": 0, "duplicateFrame": bool(is_duplicate)},
            "isGoodFrame": True,
            "duplicateFrame": bool(is_duplicate),
        }

    def get_zero_motion_direction(self):
        return {"x": 0, "y": 0, "angle": 0, "magnitude": 0, "confidence": 1, "rotation": 0}

    def cache_zero_motion_frame(self, frame, img_width, img_height, duplicate_info=None):
        flow_data = self.make_zero_motion_flow_data(bool((duplicate_info or {}).get("isDuplicate")))
        if duplicate_info:
            flow_data["duplicateInfo"] = duplicate_info
        zero = self.get_zero_motion_direction()
        self.last_flow_data = flow_data
        self.result_cache[frame] = {
            "flowData": flow_data,
            "smoothedDirection": zero,
            "angleHistory": list(self.angle_history),
            "imgWidth": img_width,
            "imgHeight": img_height,
        }

    def track_features(self, prev_gray, gray, skip_frames):
        max_corners = int(self.p("maxFeatures", 300))
        quality_level = finite(self.p("qualityLevel", 0.01), 0.01)
        min_distance = finite(self.p("minDistance", 10), 10)
        corners = cv2.goodFeaturesToTrack(prev_gray, max_corners, quality_level, min_distance)
        if corners is None or len(corners) == 0:
            return [], [], [], []

        next_pts, status, err = cv2.calcOpticalFlowPyrLK(prev_gray, gray, corners, None)
        if next_pts is None or status is None:
            return [], [], [], []

        prev_points = []
        next_points = []
        qualities = []
        track_errors = []
        max_track_error = finite(self.p("maxTrackError", 15), 15)
        motion_scale = 1.0 / max(1, skip_frames)

        for i, ok in enumerate(status.reshape(-1)):
            if int(ok) != 1:
                continue
            px, py = corners.reshape(-1, 2)[i]
            if self.is_point_masked(px, py):
                continue
            nx, ny = next_pts.reshape(-1, 2)[i]
            track_error = float(err.reshape(-1)[i]) if err is not None else 0.0
            if track_error > max_track_error:
                continue
            dx = (float(nx) - float(px)) * motion_scale
            dy = (float(ny) - float(py)) * motion_scale
            mag = magnitude(dx, dy)
            error_quality = max(0.0, 1.0 - track_error / max_track_error)
            mag_quality = min(1.0, mag / 1.0)
            prev_points.append([float(px), float(py)])
            next_points.append([float(nx), float(ny)])
            qualities.append(error_quality * mag_quality)
            track_errors.append(track_error)
        return prev_points, next_points, qualities, track_errors

    def compute_sparse_consensus(self, prev_gray, gray, img_width, img_height, skip_frames):
        prev_points, next_points, qualities, track_errors = self.track_features(prev_gray, gray, skip_frames)
        flow_vectors = []
        motion_scale = 1.0 / max(1, skip_frames)
        static_threshold = finite(self.p("staticThreshold", 0.3), 0.3)
        static_frames = finite(self.p("staticFrames", 15), 15)
        max_motion = finite(self.p("maxMotion", 100), 100)
        min_motion = finite(self.p("minMotion", 0.2), 0.2)
        min_quality = finite(self.p("minQuality", 0.3), 0.3)

        for i, p0 in enumerate(prev_points):
            px, py = p0
            nx, ny = next_points[i]
            dx = (nx - px) * motion_scale
            dy = (ny - py) * motion_scale
            mag = magnitude(dx, dy)
            key = f"{round(px / 20)}_{round(py / 20)}"
            static_score = self.static_history.get(key, 0)
            if mag < static_threshold:
                static_score = min(static_score + 1, static_frames)
            else:
                static_score = max(static_score - 2, 0)
            self.static_history[key] = static_score
            if static_score >= static_frames * 0.7:
                continue
            if mag > max_motion or mag < 0.02:
                continue
            slow_penalty = 0.7 if mag < min_motion else 1.0
            adjusted_quality = qualities[i] * slow_penalty
            if adjusted_quality < min_quality:
                continue
            flow_vectors.append({
                "px": px, "py": py, "dx": dx, "dy": dy, "mag": mag,
                "quality": adjusted_quality, "angle": angle(dx, dy),
                "trackError": track_errors[i],
            })

        consensus = self.find_consensus(flow_vectors) if len(flow_vectors) >= 3 else None
        return {"flowVectors": flow_vectors if consensus else [], "consensus": consensus}

    def compute_linear_tracklet(self, frame, img_width, img_height, skip_frames):
        source_frames = self.get_tracklet_source_frames(frame, skip_frames)
        if not source_frames:
            return {"flowVectors": [], "consensus": None}
        gray_frames = [self.read_gray(f) for f in source_frames]
        if any(g is None for g in gray_frames) or len(gray_frames) < 2:
            return {"flowVectors": [], "consensus": None}

        first_gray = gray_frames[0]
        corners = cv2.goodFeaturesToTrack(
            first_gray,
            int(self.p("maxFeatures", 300)),
            finite(self.p("qualityLevel", 0.01), 0.01),
            finite(self.p("minDistance", 10), 10),
        )
        if corners is None or len(corners) == 0:
            return {"flowVectors": [], "consensus": None}

        try:
            cv2.cornerSubPix(
                first_gray,
                corners,
                (5, 5),
                (-1, -1),
                (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_COUNT, 30, 0.01),
            )
        except Exception:
            pass

        trajectories = []
        for pt in corners.reshape(-1, 2):
            px, py = float(pt[0]), float(pt[1])
            if self.is_point_masked(px, py):
                continue
            trajectories.append({"points": [[px, py]], "valid": True, "errors": []})
        if not trajectories:
            return {"flowVectors": [], "consensus": None}

        current_points = np.array([t["points"][0] for t in trajectories], dtype=np.float32).reshape(-1, 1, 2)
        max_track_error = finite(self.p("maxTrackError", 15), 15)

        for step in range(len(gray_frames) - 1):
            prev_gray = gray_frames[step]
            next_gray = gray_frames[step + 1]
            next_pts, status, err = cv2.calcOpticalFlowPyrLK(prev_gray, next_gray, current_points, None)
            if next_pts is None or status is None:
                break

            valid_idx = 0
            for traj in trajectories:
                if not traj["valid"]:
                    continue
                if int(status.reshape(-1)[valid_idx]) != 1:
                    traj["valid"] = False
                else:
                    nx, ny = next_pts.reshape(-1, 2)[valid_idx]
                    track_error = float(err.reshape(-1)[valid_idx]) if err is not None else 0.0
                    traj["points"].append([float(nx), float(ny)])
                    traj["errors"].append(track_error)
                    if track_error > max_track_error:
                        traj["valid"] = False
                valid_idx += 1

            valid = [t for t in trajectories if t["valid"]]
            if not valid:
                break
            current_points = np.array([t["points"][-1] for t in valid], dtype=np.float32).reshape(-1, 1, 2)

        flow_vectors = []
        last_segment_flow_vectors = []
        motion_scale = 1.0 / max(1, skip_frames)
        static_threshold = finite(self.p("staticThreshold", 0.3), 0.3)
        static_frames = finite(self.p("staticFrames", 15), 15)
        max_motion = finite(self.p("maxMotion", 100), 100)
        min_motion = finite(self.p("minMotion", 0.2), 0.2)
        min_quality = finite(self.p("minQuality", 0.3), 0.3)
        linearity_threshold = finite(self.p("linearityThreshold", 0.9), 0.9)
        spacing_threshold = finite(self.p("spacingThreshold", 0.5), 0.5)

        for traj in trajectories:
            points = traj["points"]
            if not traj["valid"] or len(points) < skip_frames + 1:
                continue
            start = points[0]
            end = points[-1]
            total_dx = end[0] - start[0]
            total_dy = end[1] - start[1]
            total_dist = magnitude(total_dx, total_dy)
            if total_dist < 0.001:
                continue

            expected_step_dx = total_dx / skip_frames
            expected_step_dy = total_dy / skip_frames
            expected_step_mag = total_dist / skip_frames
            max_deviation = 0.0
            max_spacing_error = 0.0
            for i in range(1, len(points)):
                actual_dx = points[i][0] - points[i - 1][0]
                actual_dy = points[i][1] - points[i - 1][1]
                actual_mag = magnitude(actual_dx, actual_dy)
                expected_x = start[0] + expected_step_dx * i
                expected_y = start[1] + expected_step_dy * i
                deviation = magnitude(points[i][0] - expected_x, points[i][1] - expected_y)
                max_deviation = max(max_deviation, deviation)
                if expected_step_mag > 0.1:
                    max_spacing_error = max(max_spacing_error, abs(actual_mag - expected_step_mag) / expected_step_mag)

            linearity_score = max(0.0, 1.0 - max_deviation / total_dist) if total_dist > 0 else 0.0
            spacing_score = max(0.0, 1.0 - max_spacing_error)
            adapted_linearity = linearity_threshold * 0.6 if total_dist < 1.0 else linearity_threshold
            adapted_spacing = spacing_threshold * 0.6 if total_dist < 1.0 else spacing_threshold
            if linearity_score < adapted_linearity or spacing_score < adapted_spacing:
                continue

            dx = total_dx * motion_scale
            dy = total_dy * motion_scale
            mag = magnitude(dx, dy)
            penultimate = points[-2]
            last_dx = end[0] - penultimate[0]
            last_dy = end[1] - penultimate[1]
            last_mag = magnitude(last_dx, last_dy)
            key = f"{round(start[0] / 20)}_{round(start[1] / 20)}"
            static_score = self.static_history.get(key, 0)
            if mag < static_threshold:
                static_score = min(static_score + 1, static_frames)
            else:
                static_score = max(static_score - 2, 0)
            self.static_history[key] = static_score
            if static_score >= static_frames * 0.7:
                continue
            if mag > max_motion or mag < 0.02:
                continue
            avg_error = sum(traj["errors"]) / len(traj["errors"]) if traj["errors"] else 0.0
            slow_penalty = 0.7 if mag < min_motion else 1.0
            quality = max(0.0, 1.0 - avg_error / max_track_error) * linearity_score * spacing_score * slow_penalty
            if quality < min_quality:
                continue
            flow_vectors.append({
                "px": start[0], "py": start[1], "dx": dx, "dy": dy, "mag": mag,
                "quality": quality, "angle": angle(dx, dy), "trackError": avg_error,
                "linearityScore": linearity_score, "spacingScore": spacing_score,
            })
            last_segment_flow_vectors.append({
                "px": penultimate[0], "py": penultimate[1], "dx": last_dx, "dy": last_dy, "mag": last_mag,
                "quality": quality, "angle": angle(last_dx, last_dy), "trackError": avg_error,
                "linearityScore": linearity_score, "spacingScore": spacing_score,
            })

        if len(flow_vectors) < 3:
            return {"flowVectors": [], "consensus": None}
        consensus = self.find_consensus(flow_vectors)
        last_segment_consensus = self.find_consensus(last_segment_flow_vectors)
        return {"flowVectors": flow_vectors, "consensus": consensus, "lastSegmentConsensus": last_segment_consensus}

    def compute_phase_correlation(self, prev_gray, gray, img_width, img_height, skip_frames):
        shift, response = cv2.phaseCorrelate(np.float32(prev_gray), np.float32(gray))
        dx = -float(shift[0]) / max(1, skip_frames)
        dy = -float(shift[1]) / max(1, skip_frames)
        if response < 0.2:
            return self.compute_sparse_consensus(prev_gray, gray, img_width, img_height, skip_frames)
        conf = clamp(float(response), 0.5, 1.0)
        mag = magnitude(dx, dy)
        vectors = self.generate_synthetic_vectors(dx, dy, 0, img_width, img_height) if finite(self.p("minMotion", 0.2), 0.2) <= mag <= finite(self.p("maxMotion", 100), 100) else []
        return {"flowVectors": vectors, "consensus": {"dx": dx, "dy": dy, "confidence": conf, "rotation": 0, "inlierCount": len(vectors)}}

    def compute_ecc(self, prev_gray, gray, img_width, img_height, skip_frames):
        # Mirror the current browser-side MotionAnalyzer contract. The OpenCV.js
        # build used by Sitrec's browser path exposes an ECC option in the UI, but
        # effectively falls back to Affine RANSAC for this path on real footage.
        # Local Compute must return cache-compatible results, so keep the same
        # fallback unless/until the browser implementation is upgraded too.
        return self.compute_affine_ransac(prev_gray, gray, img_width, img_height, skip_frames)

    def compute_affine_ransac(self, prev_gray, gray, img_width, img_height, skip_frames):
        prev_points, next_points, qualities, _ = self.track_features(prev_gray, gray, skip_frames)
        if len(prev_points) < 4:
            return {"flowVectors": [], "consensus": None}
        prev_np = np.array(prev_points, dtype=np.float32)
        next_np = np.array(next_points, dtype=np.float32)
        transform, inliers = cv2.estimateAffine2D(prev_np, next_np, method=cv2.RANSAC, ransacReprojThreshold=finite(self.p("ransacThreshold", 3.0), 3.0))
        if transform is None or inliers is None:
            return {"flowVectors": [], "consensus": None}
        scale = 1.0 / max(1, skip_frames)
        dx = float(transform[0, 2]) * scale
        dy = float(transform[1, 2]) * scale
        rotation = math.atan2(float(transform[1, 0]), float(transform[0, 0]))
        flow_vectors = []
        inlier_count = 0
        for i, p0 in enumerate(prev_points):
            px, py = p0
            nx, ny = next_points[i]
            vdx = (nx - px) * scale
            vdy = (ny - py) * scale
            is_inlier = bool(int(inliers[i][0]) == 1)
            if is_inlier:
                inlier_count += 1
            flow_vectors.append({
                "px": px, "py": py, "dx": vdx, "dy": vdy, "mag": magnitude(vdx, vdy),
                "quality": qualities[i], "angle": angle(vdx, vdy), "isInlier": is_inlier,
            })
        return {"flowVectors": flow_vectors, "consensus": {"dx": dx, "dy": dy, "confidence": inlier_count / len(prev_points), "rotation": rotation, "inlierCount": inlier_count}}

    def generate_synthetic_vectors(self, dx, dy, rotation, img_width, img_height):
        vectors = []
        cx = img_width / 2.0
        cy = img_height / 2.0
        grid = 8
        for gx in range(grid):
            for gy in range(grid):
                px = (gx + 0.5) * img_width / grid
                py = (gy + 0.5) * img_height / grid
                if self.is_point_masked(px, py):
                    continue
                rx = px - cx
                ry = py - cy
                vdx = dx - rotation * ry
                vdy = dy + rotation * rx
                vectors.append({"px": px, "py": py, "dx": vdx, "dy": vdy, "mag": magnitude(vdx, vdy), "quality": 1.0, "angle": angle(vdx, vdy), "isInlier": True})
        return vectors

    def find_consensus(self, vectors):
        if self.p("rejectMovingObjects", True):
            global_model = self.find_consensus_global_model(vectors)
            if global_model:
                return global_model
        return self.find_consensus_direction(vectors)

    def find_consensus_direction(self, vectors):
        if len(vectors) < 3:
            return None
        num_bins = 36
        bin_size = (2 * math.pi) / num_bins
        bins = [[] for _ in range(num_bins)]
        for v in vectors:
            a = v["angle"]
            if a < 0:
                a += 2 * math.pi
            bins[int(math.floor(a / bin_size)) % num_bins].append(v)

        best_bin = -1
        best_score = 0
        for i in range(num_bins):
            neighbors = bins[(i - 1) % num_bins] + bins[i] + bins[(i + 1) % num_bins]
            score = sum(v["quality"] * max(v["mag"], 0.1) for v in neighbors)
            if score > best_score:
                best_score = score
                best_bin = i
        if best_bin < 0:
            return None
        inliers = bins[(best_bin - 1) % num_bins] + bins[best_bin] + bins[(best_bin + 1) % num_bins]
        if len(inliers) < 2:
            return None

        sum_dx = sum(v["dx"] * v["quality"] for v in inliers)
        sum_dy = sum(v["dy"] * v["quality"] for v in inliers)
        sum_weight = sum(v["quality"] for v in inliers)
        if sum_weight < 0.01:
            return None
        dx = sum_dx / sum_weight
        dy = sum_dy / sum_weight
        inlier_ratio = len(inliers) / len(vectors)
        avg_quality = sum_weight / len(inliers)
        confidence = min(1.0, inlier_ratio + 0.2) * min(1.0, avg_quality + 0.3)
        cons_mag = magnitude(dx, dy)
        for v in vectors:
            dot = (v["dx"] * dx + v["dy"] * dy) / (v["mag"] * cons_mag + 0.001) if cons_mag > 0.001 else 1
            v["isInlier"] = dot > finite(self.p("inlierThreshold", 0.6), 0.6)
        return {"dx": dx, "dy": dy, "confidence": confidence, "inlierCount": len(inliers)}

    def find_consensus_global_model(self, vectors):
        if len(vectors) < 6:
            return None
        seed = self.find_consensus_direction(vectors)
        if not seed:
            return None
        thr = finite(self.p("objectRejectThreshold", 3.0), 3.0)
        thr2 = thr * thr
        inlier = [bool(v.get("isInlier")) for v in vectors]
        affine = None
        for _ in range(5):
            fit = self.fit_affine_least_squares(vectors, inlier)
            if fit is None:
                break
            affine = fit
            a, b, c, d, e, f = fit
            next_inlier = []
            changed = False
            count = 0
            for old, v in zip(inlier, vectors):
                pred_x = a * v["px"] + b * v["py"] + c
                pred_y = d * v["px"] + e * v["py"] + f
                ex = pred_x - (v["px"] + v["dx"])
                ey = pred_y - (v["py"] + v["dy"])
                is_in = ex * ex + ey * ey <= thr2
                next_inlier.append(is_in)
                if is_in:
                    count += 1
                if is_in != old:
                    changed = True
            if count < 3:
                affine = None
                break
            inlier = next_inlier
            if not changed:
                break
        if affine is None:
            return None

        sum_dx = sum_dy = sum_weight = 0.0
        inlier_count = 0
        for i, v in enumerate(vectors):
            v["isInlier"] = bool(inlier[i])
            if inlier[i]:
                w = v["quality"]
                sum_dx += v["dx"] * w
                sum_dy += v["dy"] * w
                sum_weight += w
                inlier_count += 1
        if inlier_count < 3 or sum_weight < 0.01:
            return None
        dx = sum_dx / sum_weight
        dy = sum_dy / sum_weight
        rotation = math.atan2(affine[3], affine[0])
        inlier_ratio = inlier_count / len(vectors)
        avg_quality = sum_weight / inlier_count
        confidence = min(1.0, inlier_ratio + 0.2) * min(1.0, avg_quality + 0.3)
        return {"dx": dx, "dy": dy, "confidence": confidence, "rotation": rotation, "inlierCount": inlier_count}

    def fit_affine_least_squares(self, vectors, inlier):
        rows = []
        bx = []
        by = []
        weights = []
        for v, ok in zip(vectors, inlier):
            if not ok:
                continue
            rows.append([v["px"], v["py"], 1.0])
            bx.append(v["px"] + v["dx"])
            by.append(v["py"] + v["dy"])
            weights.append(max(v["quality"], 1e-3))
        if len(rows) < 3:
            return None
        A = np.array(rows, dtype=np.float64)
        W = np.sqrt(np.array(weights, dtype=np.float64)).reshape(-1, 1)
        try:
            sx = np.linalg.lstsq(A * W, np.array(bx, dtype=np.float64) * W.reshape(-1), rcond=None)[0]
            sy = np.linalg.lstsq(A * W, np.array(by, dtype=np.float64) * W.reshape(-1), rcond=None)[0]
        except np.linalg.LinAlgError:
            return None
        return [float(sx[0]), float(sx[1]), float(sx[2]), float(sy[0]), float(sy[1]), float(sy[2])]

    def is_good_quality_frame(self, flow_vectors, consensus):
        if not consensus:
            return False
        if len(flow_vectors) < int(self.p("minVectorCount", 5)):
            return False
        if finite(consensus.get("confidence"), 0) < finite(self.p("minConsensusConfidence", 0.1), 0.1):
            return False
        return True

    def update_smoothing(self, consensus, is_good_frame):
        if not consensus or not is_good_frame:
            return
        dx = finite(consensus.get("dx"), 0)
        dy = finite(consensus.get("dy"), 0)
        confidence = finite(consensus.get("confidence"), 0)
        if self.smoothed_direction.get("confidence", 0) < 0.01:
            self.smoothed_direction = {
                "x": dx,
                "y": dy,
                "magnitude": magnitude(dx, dy),
                "angle": angle(dx, dy),
                "confidence": confidence,
                "rotation": finite(consensus.get("rotation"), 0),
            }
        else:
            base_alpha = finite(self.p("smoothingAlpha", 0.9), 0.9)
            consensus_mag = magnitude(dx, dy)
            prev_mag = finite(self.smoothed_direction.get("magnitude"), 0)
            mag_ratio = consensus_mag / prev_mag if prev_mag > 0.01 else 1
            alpha = base_alpha * 0.5 if mag_ratio < 0.5 else base_alpha
            x = alpha * self.smoothed_direction["x"] + (1 - alpha) * dx
            y = alpha * self.smoothed_direction["y"] + (1 - alpha) * dy
            self.smoothed_direction = {
                "x": x,
                "y": y,
                "magnitude": magnitude(x, y),
                "angle": angle(x, y),
                "confidence": alpha * self.smoothed_direction["confidence"] + (1 - alpha) * confidence,
                "rotation": finite(consensus.get("rotation"), 0),
            }
        self.angle_history.append({"angle": self.smoothed_direction["angle"], "confidence": self.smoothed_direction["confidence"]})
        if len(self.angle_history) > self.max_history_length:
            self.angle_history = self.angle_history[-self.max_history_length:]

    def compute_for_frame(self, frame):
        gray = self.read_gray(frame)
        if gray is None:
            self.result_cache[frame] = {
                "flowData": None,
                "smoothedDirection": dict(self.smoothed_direction),
                "angleHistory": list(self.angle_history),
                "imgWidth": 0,
                "imgHeight": 0,
                "incomplete": True,
            }
            return
        img_height, img_width = gray.shape[:2]
        duplicate_info = self.detect_duplicate_frame(frame, gray)
        if duplicate_info.get("isDuplicate"):
            self.cache_zero_motion_frame(frame, img_width, img_height, duplicate_info)
            return

        skip_frames = max(1, int(round(finite(self.p("frameSkip", 3), 3))))
        technique = self.p("technique", MOTION_TECHNIQUES["LINEAR_TRACKLET"])
        if technique == MOTION_TECHNIQUES["LINEAR_TRACKLET"]:
            result = self.compute_linear_tracklet(frame, img_width, img_height, skip_frames)
        else:
            target_frame = self.get_prior_analysis_frame(frame, skip_frames)
            prev_gray = self.read_gray(target_frame) if target_frame >= 0 else None
            if prev_gray is None:
                result = {"flowVectors": [], "consensus": None}
            elif technique == MOTION_TECHNIQUES["PHASE_CORRELATION"]:
                result = self.compute_phase_correlation(prev_gray, gray, img_width, img_height, skip_frames)
            elif technique == MOTION_TECHNIQUES["ECC_EUCLIDEAN"]:
                result = self.compute_ecc(prev_gray, gray, img_width, img_height, skip_frames)
            elif technique == MOTION_TECHNIQUES["AFFINE_RANSAC"]:
                result = self.compute_affine_ransac(prev_gray, gray, img_width, img_height, skip_frames)
            else:
                result = self.compute_sparse_consensus(prev_gray, gray, img_width, img_height, skip_frames)

        flow_vectors = result.get("flowVectors") or []
        consensus = result.get("consensus")
        last_segment = result.get("lastSegmentConsensus")
        is_good = self.is_good_quality_frame(flow_vectors, consensus)
        self.update_smoothing(consensus, is_good)
        flow_data = {"vectors": flow_vectors, "consensus": consensus, "isGoodFrame": is_good}
        if last_segment is not None:
            flow_data["lastSegmentConsensus"] = last_segment
        self.last_flow_data = flow_data
        self.result_cache[frame] = {
            "flowData": flow_data,
            "smoothedDirection": dict(self.smoothed_direction),
            "angleHistory": list(self.angle_history),
            "imgWidth": img_width,
            "imgHeight": img_height,
        }

    def fill_bad_non_duplicate_motion_gap(self, frame):
        if not self.p("skipDuplicateFrames", True):
            return
        duplicate_info = self.duplicate_cache.get(frame)
        if duplicate_info and duplicate_info.get("isDuplicate"):
            return
        cached = self.result_cache.get(frame)
        if not cached or cached.get("incomplete"):
            return
        flow = cached.get("flowData") or {}
        if flow.get("isGoodFrame") and flow.get("consensus") and not flow.get("syntheticFrame"):
            return
        gray = self.read_gray(frame)
        if gray is None:
            return
        h, w = gray.shape[:2]
        saved = self.params.get("frameSkip", 3)
        try:
            self.params["frameSkip"] = 1
            adjacent = self.compute_linear_tracklet(frame, w, h, 1)
        finally:
            self.params["frameSkip"] = saved
        if not adjacent.get("consensus"):
            return
        cons = adjacent["consensus"]
        last = adjacent.get("lastSegmentConsensus") or cons
        flow_data = {
            "vectors": adjacent.get("flowVectors") or [],
            "consensus": cons,
            "lastSegmentConsensus": last,
            "isGoodFrame": True,
            "adjacentFallbackFrame": True,
        }
        direction = {
            "x": cons.get("dx", 0),
            "y": cons.get("dy", 0),
            "angle": angle(cons.get("dx", 0), cons.get("dy", 0)),
            "magnitude": magnitude(cons.get("dx", 0), cons.get("dy", 0)),
            "confidence": cons.get("confidence", 0),
            "rotation": 0,
        }
        cached["flowData"] = flow_data
        cached["smoothedDirection"] = direction

    def fill_bad_non_duplicate_motion_gaps(self):
        for f in range(self.a_frame, self.b_frame + 1):
            self.fill_bad_non_duplicate_motion_gap(f)

        good_frames = []
        for f in range(self.a_frame, self.b_frame + 1):
            duplicate_info = self.duplicate_cache.get(f)
            cached = self.result_cache.get(f)
            cons = (cached or {}).get("flowData", {}).get("consensus")
            if duplicate_info and duplicate_info.get("isDuplicate"):
                continue
            if cached and cached.get("flowData", {}).get("isGoodFrame") and cons:
                good_frames.append(f)
        if not good_frames:
            return

        for f in range(self.a_frame, self.b_frame + 1):
            duplicate_info = self.duplicate_cache.get(f)
            if duplicate_info and duplicate_info.get("isDuplicate"):
                continue
            cached = self.result_cache.get(f)
            if not cached or cached.get("incomplete"):
                continue
            flow = cached.get("flowData") or {}
            if flow.get("isGoodFrame") and flow.get("consensus"):
                continue

            prev_good = next_good = None
            for gf in good_frames:
                if gf < f:
                    prev_good = gf
                elif gf > f:
                    next_good = gf
                    break
            dx = dy = conf = last_dx = last_dy = last_conf = 0.0
            if prev_good is not None and next_good is not None:
                prev_flow = self.result_cache[prev_good]["flowData"]
                next_flow = self.result_cache[next_good]["flowData"]
                prev = prev_flow["consensus"]
                nextv = next_flow["consensus"]
                prev_last = prev_flow.get("lastSegmentConsensus") or prev
                next_last = next_flow.get("lastSegmentConsensus") or nextv
                t = (f - prev_good) / (next_good - prev_good)
                dx = prev["dx"] + t * (nextv["dx"] - prev["dx"])
                dy = prev["dy"] + t * (nextv["dy"] - prev["dy"])
                conf = min(prev.get("confidence", 0), nextv.get("confidence", 0)) * 0.5
                last_dx = prev_last["dx"] + t * (next_last["dx"] - prev_last["dx"])
                last_dy = prev_last["dy"] + t * (next_last["dy"] - prev_last["dy"])
                last_conf = min(prev_last.get("confidence", 0), next_last.get("confidence", 0)) * 0.5
            elif prev_good is not None:
                prev_flow = self.result_cache[prev_good]["flowData"]
                prev = prev_flow["consensus"]
                prev_last = prev_flow.get("lastSegmentConsensus") or prev
                dx, dy, conf = prev["dx"], prev["dy"], prev.get("confidence", 0) * 0.5
                last_dx, last_dy, last_conf = prev_last["dx"], prev_last["dy"], prev_last.get("confidence", 0) * 0.5
            elif next_good is not None:
                next_flow = self.result_cache[next_good]["flowData"]
                nextv = next_flow["consensus"]
                next_last = next_flow.get("lastSegmentConsensus") or nextv
                dx, dy, conf = nextv["dx"], nextv["dy"], nextv.get("confidence", 0) * 0.5
                last_dx, last_dy, last_conf = next_last["dx"], next_last["dy"], next_last.get("confidence", 0) * 0.5

            synthetic_flow = {
                "vectors": [],
                "consensus": {"dx": dx, "dy": dy, "confidence": conf, "inlierCount": 0, "synthetic": True},
                "lastSegmentConsensus": {"dx": last_dx, "dy": last_dy, "confidence": last_conf, "inlierCount": 0, "synthetic": True},
                "isGoodFrame": True,
                "syntheticFrame": True,
            }
            cached["flowData"] = synthetic_flow
            cached["smoothedDirection"] = {
                "x": dx,
                "y": dy,
                "angle": angle(dx, dy),
                "magnitude": magnitude(dx, dy),
                "confidence": conf,
                "rotation": 0,
            }

    def scan_duplicates(self, start_frame, end_frame):
        total = max(1, end_frame - start_frame + 1)
        for idx, f in enumerate(range(start_frame, end_frame + 1), 1):
            gray = self.read_gray(f)
            if gray is None:
                self.duplicate_cache[f] = {"isDuplicate": False, "identicalRatio": 0, "meanAbsDiff": float("inf")}
            else:
                self.detect_duplicate_frame(f, gray)
            if idx == 1 or idx == total or idx % 10 == 0:
                emit({"type": "progress", "progress": {"phase": "duplicates", "current": idx, "total": total, "pct": round(100 * idx / total)}})

    def run(self):
        run_t0 = time.perf_counter()
        timings = {}
        skip = max(1, int(round(finite(self.p("frameSkip", 3), 3))))
        scan_start = self.a_frame
        t0 = time.perf_counter()
        if self.p("skipDuplicateFrames", True):
            scan_start = max(1, self.a_frame - max(skip * 10, 30))
            self.scan_duplicates(scan_start, self.b_frame)
        else:
            for f in range(max(1, scan_start), self.b_frame + 1):
                self.duplicate_cache[f] = {"isDuplicate": False, "identicalRatio": 0, "meanAbsDiff": float("inf")}
        timings["duplicatesMs"] = round((time.perf_counter() - t0) * 1000, 1)

        total = max(1, self.b_frame - self.a_frame + 1)
        t0 = time.perf_counter()
        for idx, f in enumerate(range(self.a_frame, self.b_frame + 1), 1):
            self.compute_for_frame(f)
            self.fill_bad_non_duplicate_motion_gap(f)
            if idx == 1 or idx == total or idx % 5 == 0:
                emit({"type": "progress", "progress": {"phase": "analysis", "current": idx, "total": total, "pct": round(100 * idx / total)}})
        timings["analysisMs"] = round((time.perf_counter() - t0) * 1000, 1)

        emit({"type": "progress", "progress": {"phase": "fallback", "current": 0, "total": total, "pct": 0}})
        t0 = time.perf_counter()
        self.fill_bad_non_duplicate_motion_gaps()
        timings["fallbackMs"] = round((time.perf_counter() - t0) * 1000, 1)
        emit({"type": "progress", "progress": {"phase": "fallback", "current": total, "total": total, "pct": 100}})

        t0 = time.perf_counter()
        frames = []
        for f in range(self.a_frame, self.b_frame + 1):
            cached = self.result_cache.get(f)
            if cached:
                frames.append({"frame": f, "cache": cached})

        duplicates = []
        for f in sorted(self.duplicate_cache.keys()):
            if f >= scan_start and f <= self.b_frame:
                duplicates.append({"frame": f, "info": self.duplicate_cache[f]})
        timings["packMs"] = round((time.perf_counter() - t0) * 1000, 1)
        timings["totalMs"] = round((time.perf_counter() - run_t0) * 1000, 1)

        return {
            "ok": True,
            "kind": "motionAnalysis",
            "version": 1,
            "source": self.request.get("sourceRef") or self.request.get("sourceUrl") or self.request.get("source"),
            "startFrame": self.a_frame,
            "endFrame": self.b_frame,
            "frames": frames,
            "duplicates": duplicates,
            "stats": {
                "frameCount": len(frames),
                "duplicateCount": sum(1 for d in duplicates if d["info"].get("isDuplicate")),
                "technique": self.p("technique", MOTION_TECHNIQUES["LINEAR_TRACKLET"]),
                "opencv": cv2.__version__,
                "timings": timings,
                "cache": {
                    "grayLimit": self.gray_cache_limit,
                    "graySize": len(self.gray_cache),
                    "grayHits": self.gray_cache_hits,
                    "grayMisses": self.gray_cache_misses,
                    "grayFrameBytes": self.gray_frame_bytes,
                    "grayApproxMemoryMb": round(len(self.gray_cache) * self.gray_frame_bytes / (1024 * 1024), 1),
                },
                "video": {
                    "decodes": self.video.decode_count,
                    "seeks": self.video.seek_count,
                    "resizes": self.video.resize_count,
                    "readMs": round(self.video.read_seconds * 1000, 1),
                    "resizeMs": round(self.video.resize_seconds * 1000, 1),
                },
            },
        }


def main():
    try:
        request = json.load(sys.stdin)
        worker = MotionAnalyzerLocal(request)
        try:
            result = worker.run()
        finally:
            worker.close()
        emit({"type": "result", "result": result})
    except Exception as exc:
        emit({"type": "error", "error": str(exc), "trace": traceback.format_exc()})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
