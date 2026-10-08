"""BBox Extractor stays usable independently of the removed detailer."""

import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest import mock

import pytest

torch = pytest.importorskip("torch")

path = Path(__file__).resolve().parents[1] / "nodes" / "vnccs_bbox_extractor.py"
spec = importlib.util.spec_from_file_location("vnccs_bbox_extractor_test", path)
extractor = importlib.util.module_from_spec(spec)
with mock.patch.object(sys.modules["nodes"], "MAX_RESOLUTION", 16384, create=True):
    spec.loader.exec_module(extractor)


def test_detections_are_cropped_and_padded_to_one_image_batch():
    image = torch.ones(1, 40, 50, 3)
    detector = SimpleNamespace(detect=mock.Mock(return_value=((40, 50), [
        SimpleNamespace(crop_region=(0, 0, 10, 10)),
        SimpleNamespace(crop_region=(15, 5, 35, 25)),
    ])))
    result, = extractor.VNCCS_BBox_Extractor().extract(image, detector, dilation=0)
    assert tuple(result.shape) == (2, 20, 20, 3)
    assert torch.equal(result[0, :10, :10], image[0, :10, :10])
    assert torch.count_nonzero(result[0, 10:]) == 0
    assert torch.count_nonzero(result[0, :, 10:]) == 0
    assert torch.all(result[1] == 1)
    detector.detect.assert_called_once_with(image, .5, 0, 1.0, 10)
    assert extractor.NODE_CLASS_MAPPINGS == {"VNCCS_BBox_Extractor": extractor.VNCCS_BBox_Extractor}


def test_empty_detector_returns_one_black_pixel_and_batches_are_rejected():
    node = extractor.VNCCS_BBox_Extractor()
    image = torch.ones(1, 40, 50, 3)
    detector = SimpleNamespace(detect=lambda *args: ((40, 50), []))
    result, = node.extract(image, detector)
    assert tuple(result.shape) == (1, 1, 1, 3)
    assert torch.count_nonzero(result) == 0
    with pytest.raises(Exception, match="does not allow image batches"):
        node.extract(image.repeat(2, 1, 1, 1), detector)


def test_cropping_does_not_read_unused_segmentation_masks():
    class Segment:
        crop_region = (2, 3, 12, 13)

        @property
        def cropped_mask(self):
            raise AssertionError("BBox crops must not load or copy segmentation masks")

    image = torch.arange(20 * 20 * 3).reshape(1, 20, 20, 3)
    detector = SimpleNamespace(detect=lambda *args: ((20, 20), [Segment()]))
    result, = extractor.VNCCS_BBox_Extractor().extract(image, detector, dilation=0)
    assert torch.equal(result, image[:, 3:13, 2:12])
