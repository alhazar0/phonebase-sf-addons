#!/usr/bin/env python3
"""Register the clean wired iPhone frame to the fixed physical camera frame."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def load_gray(path: Path) -> tuple[np.ndarray, np.ndarray]:
    color = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if color is None:
        raise RuntimeError(f"Unable to read image: {path}")
    gray = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    return color, gray


def points(value: list[dict[str, float]]) -> np.ndarray:
    return np.float32([[item["x"], item["y"]] for item in value])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--digital", type=Path, required=True)
    parser.add_argument("--physical", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    args = parser.parse_args()

    digital_color, digital = load_gray(args.digital)
    _, physical = load_gray(args.physical)
    profile = json.loads(args.profile.read_text())

    sift = cv2.SIFT_create(nfeatures=5000, contrastThreshold=0.02)
    digital_keys, digital_desc = sift.detectAndCompute(digital, None)
    physical_keys, physical_desc = sift.detectAndCompute(physical, None)
    if digital_desc is None or physical_desc is None:
        raise RuntimeError("Not enough visual features to register the phone screen")

    matcher = cv2.BFMatcher(cv2.NORM_L2)
    pairs = matcher.knnMatch(digital_desc, physical_desc, k=2)
    good = [first for first, second in pairs if first.distance < 0.72 * second.distance]
    if len(good) < 12:
        raise RuntimeError(f"Only {len(good)} reliable visual matches; need at least 12")

    digital_points = np.float32(
        [digital_keys[match.queryIdx].pt for match in good]
    ).reshape(-1, 1, 2)
    physical_points = np.float32(
        [physical_keys[match.trainIdx].pt for match in good]
    ).reshape(-1, 1, 2)
    digital_to_physical, mask = cv2.findHomography(
        digital_points,
        physical_points,
        cv2.RANSAC,
        4.0,
    )
    if digital_to_physical is None or mask is None:
        raise RuntimeError("Unable to solve a stable digital-to-camera transform")
    inliers = mask.ravel().astype(bool)
    inlier_count = int(inliers.sum())
    if inlier_count < 10:
        raise RuntimeError(f"Only {inlier_count} inlier matches; registration rejected")

    projected_matches = cv2.perspectiveTransform(
        digital_points[inliers].reshape(-1, 1, 2),
        digital_to_physical,
    ).reshape(-1, 2)
    measured_matches = physical_points[inliers].reshape(-1, 2)
    errors = np.linalg.norm(projected_matches - measured_matches, axis=1)

    height, width = digital_color.shape[:2]
    digital_corners = np.float32(
        [[[0, 0], [width, 0], [width, height], [0, height]]]
    )
    camera_corners = cv2.perspectiveTransform(
        digital_corners,
        digital_to_physical,
    )[0]

    old_camera = points(profile["imagePoints"])
    old_machine = points(profile["machinePoints"])
    camera_to_machine = cv2.getPerspectiveTransform(old_camera, old_machine)
    digital_to_machine = camera_to_machine @ digital_to_physical
    digital_to_machine /= digital_to_machine[2, 2]
    machine_corners = cv2.perspectiveTransform(
        digital_corners,
        digital_to_machine,
    )[0]

    result = {
        "ok": True,
        "matches": len(good),
        "inliers": inlier_count,
        "inlierRatio": round(inlier_count / len(good), 4),
        "meanReprojectionErrorPx": round(float(errors.mean()), 3),
        "maximumReprojectionErrorPx": round(float(errors.max()), 3),
        "cameraCorners": [
            {"x": round(float(x), 3), "y": round(float(y), 3)}
            for x, y in camera_corners
        ],
        "machineCorners": [
            {"x": round(float(x), 3), "y": round(float(y), 3)}
            for x, y in machine_corners
        ],
        "digitalToCamera": digital_to_physical.tolist(),
        "digitalToMachine": digital_to_machine.tolist(),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
