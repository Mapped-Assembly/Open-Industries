"""Real OpenCV 5 processing of bounded images, with reproducible detector profiles."""

from __future__ import annotations

import base64
import hashlib
import io
import warnings
from typing import Any

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image

from .contracts import MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, Json, VisionError

PixelArray = NDArray[np.uint8]


def check_opencv() -> str:
    """Fail startup if the installed runtime is not the required OpenCV major."""
    if cv2.__version__.split(".")[0] != "5":
        raise VisionError("OPENCV_5_REQUIRED", 503)
    cv2.setNumThreads(1)
    return str(cv2.__version__)


def decode_image(data: bytes) -> tuple[PixelArray, str]:
    """Preflight image dimensions before native decoding; accept PNG and JPEG only."""
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise VisionError("IMAGE_TOO_LARGE" if data else "INVALID_IMAGE", 413 if data else 400)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as header:
                width, height = header.size
                fmt = header.format
                if fmt not in ("PNG", "JPEG"):
                    raise VisionError("INVALID_IMAGE")
                if max(width, height) > MAX_IMAGE_SIDE or width * height > MAX_IMAGE_PIXELS:
                    raise VisionError("IMAGE_TOO_LARGE", 413)
                header.verify()
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8),
                             cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
        if image is None or image.shape[:2] != (height, width):
            raise VisionError("INVALID_IMAGE")
        return image, "image/png" if fmt == "PNG" else "image/jpeg"
    except VisionError:
        raise
    except Exception as exc:
        raise VisionError("INVALID_IMAGE") from exc


def preview_image(image: PixelArray) -> Json:
    """Return a small JPEG for agent image content, distinct from the original hash."""
    height, width = image.shape[:2]
    scale = min(1.0, 384 / max(width, height))
    preview = cv2.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))),
                         interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise VisionError("PROCESSING_FAILED", 503)
    data = encoded.tobytes()
    return {"mime_type": "image/jpeg", "data": base64.b64encode(data).decode(),
            "sha256": hashlib.sha256(data).hexdigest(),
            "width": preview.shape[1], "height": preview.shape[0]}


def analyze_image(image: PixelArray, profile: Json) -> Json:
    """Measure image quality and optionally extract HSV color regions from pixels."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    metrics = {"mean_luma": round(float(gray.mean()), 6),
               "laplacian_variance": round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 6)}
    detections: list[dict[str, Any]] = []
    if profile["type"] == "color_regions":
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, np.array(profile["lower_hsv"], dtype=np.uint8),
                           np.array(profile["upper_hsv"], dtype=np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), dtype=np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = float(cv2.contourArea(contour))
            if area < profile["min_area_px"]:
                continue
            x, y, width, height = cv2.boundingRect(contour)
            moments = cv2.moments(contour)
            if moments["m00"] <= 0:
                continue
            detections.append({"label": profile["label"], "bbox_px": [x, y, width, height],
                               "centroid_px": [round(moments["m10"] / moments["m00"], 6),
                                               round(moments["m01"] / moments["m00"], 6)],
                               "area_px": area})
        detections.sort(key=lambda item: (item["bbox_px"][1], item["bbox_px"][0]))
        metrics["mask_fraction"] = round(float(np.count_nonzero(mask)) / mask.size, 6)
    return {"detector_version": "oi-opencv-regions/1", "opencv_version": str(cv2.__version__),
            "metrics": metrics, "detections": detections[:64],
            "detection_count": len(detections), "truncated": len(detections) > 64,
            "interpretation": "Pixel measurements; labels are configured, not semantic recognition or calibrated confidence."}
