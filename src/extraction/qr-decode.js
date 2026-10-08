// Image bytes -> QR payload strings, via sharp (decode) + jsQR (detect).
//
// Replaces the pyzbar/OpenCV pair of the Python original. Like it, a missing
// or failing decoder degrades to an empty payload list plus a note — never an
// exception — because the QR stage is a bonus.

import jsQR from "jsqr";
import sharp from "sharp";

// Phone photos are 12+ MP. jsQR's cost grows with pixel count, so frames are
// shrunk (never enlarged) to fit this box first. A slip QR spans a large share
// of the frame and survives the downscale. Not tuned against real slips yet.
export const QR_MAX_DIMENSION = 2000;

// Only raster formats reach the decoder. Uploaded bytes are untrusted, and this
// keeps SVG/PDF/TIFF parsers (librsvg, poppler, libtiff) out of the path.
const RASTER_SIGNATURES = [
  (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, // JPEG
  (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), // PNG
  (b) => b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")), // GIF
  (b) =>
    b.length >= 12 &&
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP", // WebP
];

const NOT_AN_IMAGE = "image bytes were not decodable as an image";

export function looksLikeRasterImage(bytes) {
  return RASTER_SIGNATURES.some((matches) => matches(bytes));
}

/** Returns { payloads, notes }. */
export async function decodeQrPayloads(imageBytes) {
  if (!looksLikeRasterImage(imageBytes)) return { payloads: [], notes: [NOT_AN_IMAGE] };

  let pixels;
  try {
    pixels = await sharp(imageBytes)
      .resize({
        width: QR_MAX_DIMENSION,
        height: QR_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return { payloads: [], notes: [NOT_AN_IMAGE] };
  }

  const { data, info } = pixels;
  try {
    const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
    const code = jsQR(rgba, info.width, info.height, { inversionAttempts: "attemptBoth" });
    return { payloads: code?.data ? [code.data] : [], notes: [] };
  } catch (error) {
    return { payloads: [], notes: ["jsQR failed: " + error.message] };
  }
}
