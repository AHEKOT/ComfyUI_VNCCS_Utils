"""TripoSplat source framing in viewer coordinates, without model execution."""

import math

import numpy as np
import pytest

from helpers.backend_package import service_package


camera = service_package("vnccs_source_camera_test")("nodes.factory3d.source_camera")


@pytest.mark.parametrize("size", [(1200, 800), (800, 1200), (1024, 1024)])
def test_source_camera_restores_padding_aspect_and_gaussian_coordinate_transform(size):
    direction = np.array([1, 2, 3], dtype=float)
    result = camera.decode_source_camera([*direction, 0.5, 0.8], size)
    np.testing.assert_allclose(result["position"], direction[[1, 2, 0]] / np.linalg.norm(direction) * 2)
    assert result["target"] == [0, 0, 0] and result["up"] == [0, 1, 0]
    projected_height = 2 * math.hypot(*result["position"]) * math.tan(math.radians(result["fov"]) / 2)
    assert projected_height == pytest.approx(1.6 * size[1] / (1.2 * max(size)))
    assert projected_height * size[0] / size[1] == pytest.approx(1.6 * size[0] / (1.2 * max(size)))


def test_near_orthographic_prediction_has_bounded_fov_and_preserves_image_plane_size():
    result = camera.decode_source_camera([0, 1, 0, 0, 0.6], (1024, 1024))
    distance = math.hypot(*result["position"])
    assert result["fov"] == 5
    assert 0 < distance <= 1e6 and all(math.isfinite(value) for value in result["position"])
    assert distance * math.tan(math.radians(2.5)) == pytest.approx(0.5)


@pytest.mark.parametrize("latent", [[1, 2], [0, 0, 0, 1, 1], [1e-9, 0, 0, 1, 1],
    [1, 0, 0, 1, 0], [1, 0, 0, 1, -1], [float("nan"), 0, 0, 1, 1],
    [1, 0, 0, float("inf"), 1], [1, 0, 0, 0, 1e12]])
def test_invalid_degenerate_and_unbounded_predictions_fail_explicitly(latent):
    with pytest.raises(ValueError, match="camera"):
        camera.decode_source_camera(latent, (1024, 1024))
