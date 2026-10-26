"""Create explicitly synthetic camera input and a runnable local vision configuration."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def make_demo(output: Path) -> None:
    """Write two yellow targets and one blue distractor, with no credentials in files."""
    output.mkdir(parents=True, exist_ok=True)
    image = np.zeros((240, 320, 3), dtype=np.uint8)
    cv2.rectangle(image, (35, 45), (85, 95), (0, 255, 255), -1)
    cv2.circle(image, (220, 155), 24, (0, 255, 255), -1)
    cv2.rectangle(image, (120, 30), (160, 70), (255, 0, 0), -1)
    if not cv2.imwrite(str(output / "frame.png"), image):
        raise RuntimeError("Could not write fixture image")
    config = {"cameras": [{"camera_id": "demo-overhead", "machine_id": "demo-machine",
                            "adapter": "file", "path": "frame.png", "evidence_kind": "fixture"}],
              "principals": [{"principal_id": "demo-agent", "machines": ["demo-machine"],
                               "token_env": "OI_VISION_TOKEN"}],
              "profiles": [{"profile_id": "quality", "type": "image_quality"},
                           {"profile_id": "yellow-regions", "type": "color_regions", "label": "yellow-region",
                            "lower_hsv": [20, 100, 100], "upper_hsv": [40, 255, 255], "min_area_px": 30}]}
    (output / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    print(f"Created declared fixture image and camera configuration in {output}")


def main() -> None:
    """Accept an explicit output directory, defaulting to ignored local service state."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".astra/vision-demo"))
    make_demo(parser.parse_args().output)


if __name__ == "__main__":
    main()
