import torch
import ultralytics
import numpy as np
import torchvision
import torchvision.transforms.functional


class PersonDetector(torch.nn.Module):
    def __init__(self, ):
        super().__init__()
        self.input_size = 416
        self.yolo = ultralytics.YOLO('yolov8m.pt')

    def forward(self, images, threshold, nms_iou_threshold, max_detections):
        h = np.float32(images.shape[2])
        w = np.float32(images.shape[3])
        max_side = np.maximum(h, w)
        factor = self.input_size / max_side
        target_w = np.int32(factor * w)
        target_h = np.int32(factor * h)
        images = (images.float() / 255) ** 2.2
        images = torchvision.transforms.functional.resize(
            images, (target_h, target_w), antialias=factor < 1)
        images = images ** (1 / 2.2)
        pad_h = -target_h % 32
        pad_w = -target_w % 32
        half_pad_h = pad_h // 2
        half_pad_w = pad_w // 2
        half_pad_h_float = np.float32(half_pad_h)
        half_pad_w_float = np.float32(half_pad_w)
        images = torch.nn.functional.pad(
            images, (half_pad_w, pad_w - half_pad_w, half_pad_h, pad_h - half_pad_h),
            value=0.5)

        with torch.autocast(dtype=torch.float16, device_type='cuda'):
            yolo_results = self.yolo.predict(
                source=images, conf=threshold, iou=nms_iou_threshold,
                max_det=max_detections, classes=[0], verbose=False)
        y_factor = h / np.float32(target_h)
        x_factor = w / np.float32(target_w)

        return [
            scale_boxes(r.boxes, half_pad_w_float, half_pad_h_float, x_factor, y_factor)
            for r in yolo_results]


def scale_boxes(boxes, half_pad_w_float, half_pad_h_float, x_factor, y_factor):
    return torch.stack([
        (boxes.xyxy[:, 0] - half_pad_w_float) * x_factor,
        (boxes.xyxy[:, 1] - half_pad_h_float) * y_factor,
        (boxes.xywh[:, 2]) * x_factor,
        (boxes.xywh[:, 3]) * y_factor,
        boxes.conf
    ], dim=1)
