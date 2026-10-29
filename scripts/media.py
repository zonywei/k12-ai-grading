#!/usr/bin/env python3
"""Private answer crop helper. All dimensions are pixels of the captured source image."""
import json
from pathlib import Path
import sys
from PIL import Image


def crop(source, output, region):
    with Image.open(source) as image:
        x, y, w, h = region
        if not all(isinstance(v, int) for v in region) or x < 0 or y < 0 or w <= 0 or h <= 0 or x+w > image.width or y+h > image.height:
            raise ValueError('裁剪框超出图像')
        # Re-encode pixels only; strip EXIF, text chunks and any source metadata.
        result = image.crop((x, y, x+w, y+h)).convert('RGB')
        result.save(output, format='PNG')
    if sys.platform != 'win32':
        Path(output).chmod(0o600)


if __name__ == '__main__':
    data = json.load(sys.stdin)
    crop(data['source'], data['output'], data['region'])
