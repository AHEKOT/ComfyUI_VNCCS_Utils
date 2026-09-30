import { test, expect } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { measureAlphaBBoxInPage } from "./helpers/measure.mjs";
import { expect as _expect } from "@playwright/test";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Minimal RGBA PNG encoder so the measurement has a deterministic fixture. */
function makeRgbaPng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Block a frame of 6x5 opaque pixels with 1px transparent padding:
// x in [3, 8], y in [2, 6] -> every row sum is 33, and 33/6 = 5.5.
function fixturePng() {
  const size = 10;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 2; y <= 6; y += 1) {
    for (let x = 3; x <= 8; x += 1) pixels[(y * size + x) * 4 + 3] = 255;
  }
  return `data:image/png;base64,${makeRgbaPng(size, size, pixels).toString("base64")}`;
}

test("measureAlphaBBox reports the exact alpha bounding box and centroid", async ({ page }) => {
  await page.goto("about:blank");
  const bbox = await measureAlphaBBoxInPage(page, fixturePng());
  expect(bbox).toEqual({
    minX: 3, minY: 2, maxX: 8, maxY: 6,
    width: 6, height: 5,
    centroidX: 5.5, centroidY: 4, area: 30,
  });
});

test("measureAlphaBBox reports an empty measurement for a fully transparent image", async ({ page }) => {
  await page.goto("about:blank");
  const size = 10;
  const bbox = await measureAlphaBBoxInPage(page, `data:image/png;base64,${makeRgbaPng(size, size, Buffer.alloc(size * size * 4)).toString("base64")}`);
  expect(bbox.area).toBe(0);
  expect(bbox.width).toBe(0);
  expect(bbox.height).toBe(0);
  expect(bbox.centroidX).toBeNull();
  expect(bbox.centroidY).toBeNull();
});
