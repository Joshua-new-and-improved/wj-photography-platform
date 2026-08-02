import sharp from "sharp";
import type { Metadata } from "sharp";
import { createHash } from "node:crypto";

/**
 * Media derivation.
 *
 * One original in, a ladder of variants out (architecture §8.1). Three rules
 * govern everything here:
 *
 *   1. Nothing reachable before payment is unwatermarked. The database enforces
 *      this too (`variant_preview_kinds_are_watermarked` in migration 0005),
 *      because a structural guarantee beats a convention.
 *   2. GPS never survives derivation. A preview of a child carrying the
 *      coordinates of their school is a genuinely bad thing to put on the
 *      public internet, and it is a two-line fix at the point of derivation.
 *   3. Untrusted bytes are validated before a decode buffer is allocated.
 */

export type VariantKind = "thumb" | "preview" | "proof" | "print";

export interface VariantSpec {
  kind: VariantKind;
  longEdge: number | null; // null = full resolution
  watermarked: boolean;
  /** Byte budget from §8.3. Enforced by the weight test, not by the encoder. */
  maxBytes: number | null;
  formats: Array<"avif" | "webp" | "jpeg">;
  quality: number;
}

/**
 * The ladder. Weights are chosen against §8.3's budget: a 24-thumbnail gallery
 * has to render inside 600 KB total on a mid-range Android phone on a mobile
 * connection, because South African mobile data is expensive relative to income
 * and a gallery that ships 40 MB is a gallery some parents close.
 */
export const VARIANTS: readonly VariantSpec[] = [
  { kind: "thumb", longEdge: 400, watermarked: true, maxBytes: 25_000, formats: ["avif", "webp"], quality: 50 },
  { kind: "preview", longEdge: 1200, watermarked: true, maxBytes: 120_000, formats: ["avif", "webp"], quality: 55 },
  { kind: "proof", longEdge: 2048, watermarked: true, maxBytes: 300_000, formats: ["webp"], quality: 60 },
  { kind: "print", longEdge: null, watermarked: false, maxBytes: null, formats: ["jpeg"], quality: 95 },
];

/**
 * Refuse anything whose declared dimensions are implausible.
 *
 * This is the standard denial-of-service vector for any service accepting user
 * images: a 100 KB file that declares 60000x60000 pixels and asks the server to
 * allocate a decode buffer for it. sharp has its own pixel limit; this check
 * runs first and produces an error the import UI can explain.
 */
export const MAX_PIXELS = 120_000_000; // ~120 MP, above any camera in use
export const MAX_INPUT_BYTES = 200 * 1024 * 1024;

export class UnsafeImageError extends Error {}

export interface SourceMetadata {
  width: number;
  height: number;
  format: string;
  bytes: number;
  sha256: Buffer;
  capturedAt: Date | null;
  cameraModel: string | null;
  /** True when the source carried location data. Recorded so the studio can
   *  see that it existed, and prove it was removed. */
  hadGps: boolean;
}

export interface DerivedVariant {
  kind: VariantKind;
  format: "avif" | "webp" | "jpeg";
  data: Buffer;
  width: number;
  height: number;
  bytes: number;
  watermarked: boolean;
}

/** Inspect and validate before doing any real work. */
export async function inspect(input: Buffer): Promise<SourceMetadata> {
  if (input.byteLength > MAX_INPUT_BYTES) {
    throw new UnsafeImageError(
      `File is ${(input.byteLength / 1e6).toFixed(0)} MB, above the ${MAX_INPUT_BYTES / 1e6} MB limit.`,
    );
  }

  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch (err) {
    throw new UnsafeImageError(`Not a readable image: ${(err as Error).message}`);
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 1 || height < 1) throw new UnsafeImageError("Image has no dimensions.");
  if (width * height > MAX_PIXELS) {
    throw new UnsafeImageError(
      `Image declares ${width}x${height} (${((width * height) / 1e6).toFixed(0)} MP), above the ${MAX_PIXELS / 1e6} MP limit.`,
    );
  }

  const exifSummary = readExif(meta.exif);

  // EXIF orientation 5-8 swap the axes. Report post-rotation dimensions, since
  // that is what every downstream consumer means by width and height.
  const swapped = (meta.orientation ?? 1) >= 5;

  return {
    width: swapped ? height : width,
    height: swapped ? width : height,
    format: meta.format ?? "unknown",
    bytes: input.byteLength,
    sha256: createHash("sha256").update(input).digest(),
    capturedAt: exifSummary.capturedAt,
    cameraModel: exifSummary.cameraModel,
    hadGps: exifSummary.hasGps,
  };
}

/**
 * Tiled diagonal watermark.
 *
 * Deliberately not a discreet corner logo — a corner logo is cropped out in
 * about four seconds. It has to be irritating enough to prevent use as a
 * keepsake and light enough that a parent can still judge whether they like the
 * photograph. Where exactly that balance sits is a question to test with real
 * parents rather than to guess at; `opacity` is the dial.
 */
export function watermarkSvg(
  width: number,
  height: number,
  text: string,
  opacity = 0.28,
): Buffer {
  // Scale the mark with the image so a thumbnail and a proof look alike.
  const fontSize = Math.max(11, Math.round(Math.min(width, height) / 14));
  const stepX = fontSize * 11;
  const stepY = fontSize * 5;

  let tiles = "";
  for (let y = -stepY; y < height + stepY; y += stepY) {
    // Offset alternate rows so the pattern does not form vertical corridors a
    // crop could slip between.
    const rowOffset = ((y / stepY) % 2 === 0 ? 0 : stepX / 2) - stepX;
    for (let x = rowOffset; x < width + stepX; x += stepX) {
      tiles += `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" font-weight="600" fill="#ffffff" fill-opacity="${opacity}" stroke="#000000" stroke-opacity="${opacity * 0.4}" stroke-width="0.6">${escapeXml(text)}</text>`;
    }
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<g transform="rotate(-30 ${width / 2} ${height / 2})">${tiles}</g></svg>`,
  );
}

export interface DeriveOptions {
  /** Text tiled across every pre-purchase variant. */
  watermarkText: string;
  /** Restrict the ladder, e.g. to regenerate one size. */
  only?: VariantKind[];
}

/** Produce the full variant ladder from one original. */
export async function deriveVariants(
  input: Buffer,
  opts: DeriveOptions,
): Promise<{ source: SourceMetadata; variants: DerivedVariant[] }> {
  const source = await inspect(input);
  const specs = opts.only
    ? VARIANTS.filter((v) => opts.only!.includes(v.kind))
    : VARIANTS;

  const out: DerivedVariant[] = [];

  for (const spec of specs) {
    // `.rotate()` with no argument applies the EXIF orientation and then drops
    // the tag, so downstream consumers never have to think about it again.
    //
    // sharp discards metadata unless explicitly asked to keep it. That default
    // is what strips GPS, and it is load-bearing: adding `.withMetadata()` here
    // to "keep the copyright field" would quietly reintroduce the coordinates
    // of a primary school onto a public URL.
    let pipeline = sharp(input, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .toColourspace("srgb");

    if (spec.longEdge) {
      pipeline = pipeline.resize({
        width: spec.longEdge,
        height: spec.longEdge,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    if (spec.watermarked) {
      // Resize first so the watermark is composited at output scale — marking
      // the full-resolution image and then downsampling turns the text to mush.
      const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
      pipeline = sharp(data, {
        raw: { width: info.width, height: info.height, channels: info.channels },
      }).composite([
        { input: watermarkSvg(info.width, info.height, opts.watermarkText), blend: "over" },
      ]);
    }

    for (const format of spec.formats) {
      const encoded =
        format === "avif"
          ? pipeline.clone().avif({ quality: spec.quality, effort: 4 })
          : format === "webp"
            ? pipeline.clone().webp({ quality: spec.quality })
            : pipeline.clone().jpeg({ quality: spec.quality, mozjpeg: true, chromaSubsampling: "4:4:4" });

      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      out.push({
        kind: spec.kind,
        format,
        data,
        width: info.width,
        height: info.height,
        bytes: data.byteLength,
        watermarked: spec.watermarked,
      });
    }
  }

  return { source, variants: out };
}

/**
 * 64-bit difference hash, for grouping near-duplicates.
 *
 * A photographer shooting eight frames of one child produces eight nearly
 * identical images. Grouping them lets the tagging UI show one card instead of
 * eight, and lets the gallery lead with the best of a burst rather than the
 * first. Not a security control — perceptual hashes are trivially collided on
 * purpose, and nothing here depends on that not happening.
 */
export async function perceptualHash(input: Buffer): Promise<string> {
  const { data } = await sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += data[y * 9 + x]! > data[y * 9 + x + 1]! ? "1" : "0";
    }
  }
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

/**
 * Minimal TIFF/EXIF reader.
 *
 * Deliberately hand-rolled rather than pulled from a dependency: this runs on
 * every uploaded file, which is the least trusted input in the system, and the
 * whole parser is a bounded walk over two IFDs with every offset checked
 * against the buffer length. A general-purpose EXIF library is a much larger
 * attack surface for four fields.
 *
 * The first attempt at this was a byte scan for the GPS tag pattern, which
 * reported false in a file that demonstrably carried GPS — pattern-matching
 * bytes cannot tell a tag from a coincidence. Structure has to be parsed.
 */
interface ExifSummary {
  capturedAt: Date | null;
  cameraModel: string | null;
  hasGps: boolean;
}

const TAG_MODEL = 0x0110;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;

export function readExif(exif: Buffer | undefined): ExifSummary {
  const empty: ExifSummary = { capturedAt: null, cameraModel: null, hasGps: false };
  if (!exif || exif.length < 8) return empty;

  // sharp hands back the segment including the "Exif\0\0" preamble.
  const tiff = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? 6 : 0;
  if (exif.length < tiff + 8) return empty;

  const order = exif.readUInt16BE(tiff);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return empty;

  const u16 = (o: number) => (le ? exif.readUInt16LE(o) : exif.readUInt16BE(o));
  const u32 = (o: number) => (le ? exif.readUInt32LE(o) : exif.readUInt32BE(o));

  if (u16(tiff + 2) !== 42) return empty;

  const result: ExifSummary = { ...empty };
  const seen = new Set<number>();

  const walk = (ifdOffset: number, depth: number): void => {
    // Bound the walk: malformed files can point an IFD at itself.
    if (depth > 2 || seen.has(ifdOffset)) return;
    seen.add(ifdOffset);

    const base = tiff + ifdOffset;
    if (base + 2 > exif.length) return;
    const count = u16(base);
    if (count > 512) return; // implausible; treat as corrupt

    for (let i = 0; i < count; i++) {
      const entry = base + 2 + i * 12;
      if (entry + 12 > exif.length) return;

      const tag = u16(entry);
      const type = u16(entry + 2);
      const n = u32(entry + 4);
      const size = n * (type === 2 ? 1 : type === 3 ? 2 : 4);
      const valueOffset = size <= 4 ? entry + 8 : tiff + u32(entry + 8);

      switch (tag) {
        case TAG_GPS_IFD:
          result.hasGps = true;
          break;
        case TAG_EXIF_IFD:
          walk(u32(entry + 8), depth + 1);
          break;
        case TAG_MODEL:
          result.cameraModel ??= readAscii(exif, valueOffset, n);
          break;
        case TAG_DATETIME:
        case TAG_DATETIME_ORIGINAL: {
          const d = parseExifDateString(readAscii(exif, valueOffset, n));
          // DateTimeOriginal is when the shutter fired; DateTime is when the
          // file was last written. Segmentation needs the former, so prefer it.
          if (d && (tag === TAG_DATETIME_ORIGINAL || !result.capturedAt)) {
            result.capturedAt = d;
          }
          break;
        }
      }
    }
  };

  walk(u32(tiff + 4), 0);
  return result;
}

function readAscii(buf: Buffer, offset: number, length: number): string | null {
  if (offset < 0 || offset + length > buf.length || length < 1) return null;
  return buf.subarray(offset, offset + length).toString("latin1").replace(/\0+$/, "").trim() || null;
}

/** EXIF dates are 'YYYY:MM:DD HH:MM:SS', with no timezone. */
function parseExifDateString(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  // Cameras record local wall-clock time with no offset. Treated as UTC here
  // so ordering is stable; only differences matter for segmentation, and the
  // import worker records the shoot's timezone alongside it.
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
