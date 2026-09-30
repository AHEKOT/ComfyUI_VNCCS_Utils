"""Shared image helpers for the UniCanvas layer-utility tests."""

import base64
import io

from PIL import Image


def png_data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def decode_png_data_url(data_url):
    payload = data_url.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(payload)))
