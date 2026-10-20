"""Decode TripoSplat's predicted input camera into Factory viewer coordinates."""

import math

import numpy as np


def decode_source_camera(latent, image_size):
    # Upstream: TripoSplat-Training/deg/utils/render_utils.py, [dx, dy, dz, k, w].
    values = np.asarray(latent, dtype=np.float64).reshape(-1)
    if values.size != 5 or not np.isfinite(values).all():
        raise ValueError("TripoSplat predicted an invalid source camera")
    direction, inverse_distance, half_width = values[:3], values[3], values[4]
    length = np.linalg.norm(direction)
    if not math.isfinite(length) or length < 1e-6 or half_width <= 0:
        raise ValueError("TripoSplat predicted a degenerate source camera")
    width, height = image_size
    # Undo the square conditioning image's 20% padding and restore the input aspect.
    half_height = half_width * height / (1.2 * max(width, height))
    distance = 1 / inverse_distance if inverse_distance >= 1e-3 else 1000.0
    fov = math.degrees(2 * math.atan(half_height / distance))
    # shortcut: near-orthographic predictions use 5° perspective; add true ortho if needed.
    bounded_fov = max(5.0, min(120.0, fov))
    distance = half_height / math.tan(math.radians(bounded_fov) / 2)
    if not math.isfinite(distance) or not 1e-7 < distance <= 1e6:
        raise ValueError("TripoSplat predicted an out-of-range source camera")
    # Gaussian.save_ply's X rotation followed by Factory's canonical orientation.
    position = direction[[1, 2, 0]] * (distance / length)
    return {
        "position": position.tolist(),
        "target": [0.0, 0.0, 0.0],
        "up": [0.0, 1.0, 0.0],
        "fov": bounded_fov,
    }
