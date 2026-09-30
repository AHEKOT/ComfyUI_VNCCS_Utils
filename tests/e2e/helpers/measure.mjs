/**
 * Alpha-bounding-box measurement of rendered layer pixels.
 *
 * `measureAlphaBBox` is a pure function: it is serialized into the page by
 * `measureAlphaBBoxInPage`, so it may only use browser globals.
 */
export async function measureAlphaBBox(dataURL) {
  const bitmap = await createImageBitmap(await (await fetch(dataURL)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  let minX = width, minY = height, maxX = -1, maxY = -1, area = 0, sumX = 0, sumY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < 8) continue;
      area += 1; sumX += x; sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (area === 0) return { minX, minY, maxX, maxY, width: 0, height: 0, centroidX: null, centroidY: null, area: 0 };
  return {
    minX, minY, maxX, maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centroidX: sumX / area,
    centroidY: sumY / area,
    area,
  };
}

// measureAlphaBBox needs OffscreenCanvas, so specs run it inside the page.
export const measureAlphaBBoxInPage = (page, dataURL) => page.evaluate(measureAlphaBBox, dataURL);
