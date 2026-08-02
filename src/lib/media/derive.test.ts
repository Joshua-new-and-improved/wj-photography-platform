import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  inspect,
  deriveVariants,
  perceptualHash,
  hammingDistance,
  readExif,
  watermarkSvg,
  UnsafeImageError,
  VARIANTS,
  MAX_PIXELS,
} from "./derive.js";

/**
 * A stand-in for a school portrait: portrait orientation, a vertical gradient
 * plus fine noise. Flat colour compresses to almost nothing and would make the
 * weight budgets pass meaninglessly.
 */
async function portrait(width = 4000, height = 6000): Promise<Buffer> {
  const channels = 3;
  const px = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const base = Math.round(40 + (y / height) * 160);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const n = ((x * 2654435761 + y * 40503) % 37) - 18;
      px[i] = clamp(base + n);
      px[i + 1] = clamp(base - 12 + n);
      px[i + 2] = clamp(base + 25 + n);
    }
  }
  return sharp(px, { raw: { width, height, channels } }).jpeg({ quality: 92 }).toBuffer();
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Building a 24 MP source is seconds of work. Do it once for the whole file. */
let fullRes: Promise<Buffer> | undefined;
const fullResPortrait = () => (fullRes ??= portrait(4000, 6000));

/**
 * A minimal, hand-built EXIF block carrying a GPS IFD pointer.
 *
 * sharp cannot *write* a GPS IFD — the first version of this test asked it to
 * and then asserted the parser was broken when nothing came back. So the
 * parser is exercised against a buffer built to the TIFF spec by hand, which
 * is a sharper test anyway: it pins the exact structure rather than whatever
 * an encoder happens to emit.
 */
function exifWithGps(): Buffer {
  const b = Buffer.alloc(50);
  b.write("Exif\0\0", 0, "latin1");
  const T = 6; // TIFF header start
  b.write("II", T, "latin1");
  b.writeUInt16LE(42, T + 2);
  b.writeUInt32LE(8, T + 4); // IFD0 at offset 8

  const ifd0 = T + 8;
  b.writeUInt16LE(1, ifd0); // one entry
  b.writeUInt16LE(0x8825, ifd0 + 2); // GPS IFD pointer
  b.writeUInt16LE(4, ifd0 + 4); // LONG
  b.writeUInt32LE(1, ifd0 + 6);
  b.writeUInt32LE(26, ifd0 + 10); // GPS IFD at offset 26
  b.writeUInt32LE(0, ifd0 + 14); // no next IFD

  const gps = T + 26;
  b.writeUInt16LE(1, gps);
  b.writeUInt16LE(0x0001, gps + 2); // GPSLatitudeRef
  b.writeUInt16LE(2, gps + 4); // ASCII
  b.writeUInt32LE(2, gps + 6);
  b.write("S\0", gps + 10, "latin1");
  b.writeUInt32LE(0, gps + 14);
  return b;
}

/** The same image, carrying the metadata a real camera would attach. */
async function portraitWithExif(): Promise<Buffer> {
  const base = await portrait(1600, 2400);
  return sharp(base)
    // sharp's Exif type does not declare ExifIFD, but libvips writes it — and
    // DateTimeOriginal (shutter time) is the field segmentation depends on.
    .withExif({
      IFD0: { Model: "Canon EOS R6", DateTime: "2026:08:01 09:15:22" },
      ExifIFD: { DateTimeOriginal: "2026:08:01 09:15:22" },
      GPS: {
        GPSLatitudeRef: "S",
        GPSLatitude: "25/1 44/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "28/1 11/1 0/1",
      },
    } as never)
    .jpeg()
    .toBuffer();
}

describe("inspection", () => {
  it("reads dimensions and a content hash", async () => {
    const meta = await inspect(await portrait(800, 1200));
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(1200);
    expect(meta.format).toBe("jpeg");
    expect(meta.sha256).toHaveLength(32);
  });

  it("extracts the shutter time segmentation depends on", async () => {
    // If this regresses, slate segmentation silently loses its ordering.
    const meta = await inspect(await portraitWithExif());
    expect(meta.capturedAt?.toISOString()).toBe("2026-08-01T09:15:22.000Z");
    expect(meta.cameraModel).toBe("Canon EOS R6");
  });

  it("does not claim GPS where there is none", async () => {
    expect((await inspect(await portrait(400, 400))).hadGps).toBe(false);
  });

  it("rejects a decompression bomb before allocating a decode buffer", async () => {
    // The standard denial-of-service vector: a small file declaring enormous
    // dimensions. Must fail as a handled error the import UI can explain, not
    // as an out-of-memory kill.
    const bomb = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer();
    const forged = Buffer.from(bomb);
    // IHDR width/height live at bytes 16-23 of a PNG.
    forged.writeUInt32BE(60000, 16);
    forged.writeUInt32BE(60000, 20);
    await expect(inspect(forged)).rejects.toBeInstanceOf(UnsafeImageError);
  });

  it("rejects a file that is not an image at all", async () => {
    await expect(inspect(Buffer.from("this is a PDF, honestly"))).rejects.toBeInstanceOf(
      UnsafeImageError,
    );
  });

  it("has a pixel ceiling above any camera in use", () => {
    // 120 MP. A Fujifilm GFX100 shoots 102 MP; this must not reject real work.
    expect(MAX_PIXELS).toBeGreaterThan(102_000_000);
  });
});

describe("EXIF parsing", () => {
  it("detects a GPS IFD pointer", () => {
    // The flag that lets the studio show location data existed on the source
    // and prove it was removed from everything served (§7.4).
    expect(readExif(exifWithGps()).hasGps).toBe(true);
  });

  it("does not mistake coincidental bytes for a GPS tag", () => {
    // An earlier version scanned for the byte pattern 0x88 0x25 anywhere in the
    // block, which finds it in ordinary pixel-adjacent data. Structure has to
    // be parsed, not pattern-matched.
    const noise = Buffer.alloc(200);
    for (let i = 0; i < noise.length; i += 2) {
      noise[i] = 0x88;
      noise[i + 1] = 0x25;
    }
    expect(readExif(noise).hasGps).toBe(false);
  });

  it("survives malformed input without throwing", () => {
    // This parser runs on the least trusted input in the system.
    for (const junk of [
      undefined,
      Buffer.alloc(0),
      Buffer.from("Exif\0\0"),
      Buffer.from([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0xff, 0xff]),
      Buffer.from("Exif\0\0II*\0\u0008\0\0\0\u00ff\u00ff"),
    ]) {
      expect(() => readExif(junk as Buffer | undefined)).not.toThrow();
    }
  });
});

describe("derivation", () => {
  it("removes GPS from every derivative", async () => {
    // The load-bearing privacy guarantee (§7.4). A preview of a child carrying
    // the coordinates of their primary school must never reach a public URL.
    const { source, variants } = await deriveVariants(await portraitWithExif(), {
      watermarkText: "O'Neills",
    });

    // The source carries a full EXIF block including the shutter time.
    expect(source.capturedAt).not.toBeNull();
    for (const v of variants) {
      const meta = await sharp(v.data).metadata();
      expect(readExif(meta.exif).hasGps, `${v.kind}/${v.format} leaked GPS`).toBe(false);
      // Belt and braces: no EXIF block at all on any derivative.
      expect(meta.exif, `${v.kind}/${v.format} retained EXIF`).toBeUndefined();
    }
  });

  it("produces the full ladder at the right sizes", async () => {
    const { variants } = await deriveVariants(await fullResPortrait(), {
      watermarkText: "O'Neills",
    });

    const thumb = variants.find((v) => v.kind === "thumb" && v.format === "avif")!;
    expect(Math.max(thumb.width, thumb.height)).toBe(400);

    const preview = variants.find((v) => v.kind === "preview" && v.format === "avif")!;
    expect(Math.max(preview.width, preview.height)).toBe(1200);

    // The print variant keeps full resolution — it is what goes to the lab.
    const print = variants.find((v) => v.kind === "print")!;
    expect(print.width).toBe(4000);
    expect(print.height).toBe(6000);
  });

  it("watermarks everything reachable before payment, and nothing after", async () => {
    const { variants } = await deriveVariants(await portrait(1200, 1800), {
      watermarkText: "O'Neills",
    });
    for (const v of variants) {
      expect(v.watermarked, `${v.kind} watermark flag`).toBe(v.kind !== "print");
    }
  });

  it("actually alters the pixels rather than just setting a flag", async () => {
    // A watermark that is recorded but not composited is worse than none,
    // because everyone downstream believes it is there.
    const src = await portrait(1200, 1800);
    const marked = (
      await deriveVariants(src, { watermarkText: "O'Neills", only: ["preview"] })
    ).variants.find((v) => v.format === "webp")!;

    const plain = await sharp(src)
      .resize({ width: 1200, height: 1200, fit: "inside" })
      .webp({ quality: 55 })
      .toBuffer();

    const a = await sharp(marked.data).greyscale().raw().toBuffer();
    const b = await sharp(plain).greyscale().raw().toBuffer();
    expect(a.length).toBe(b.length);

    let changed = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 6) changed++;
    const proportion = changed / a.length;

    // Tiled across the whole frame, so a meaningful share of pixels moves —
    // a corner logo would be croppable in about four seconds (§8.4).
    expect(proportion).toBeGreaterThan(0.02);
    // But still legible underneath: a parent has to be able to judge the photo.
    expect(proportion).toBeLessThan(0.6);
  });

  it("meets the mobile data budget from §8.3", async () => {
    const { variants } = await deriveVariants(await fullResPortrait(), {
      watermarkText: "O'Neills",
    });
    for (const spec of VARIANTS) {
      if (spec.maxBytes === null) continue;
      for (const v of variants.filter((x) => x.kind === spec.kind)) {
        expect(v.bytes, `${v.kind}/${v.format} is ${v.bytes} bytes`).toBeLessThanOrEqual(
          spec.maxBytes,
        );
      }
    }
  });

  it("keeps a 24-thumbnail gallery inside 600 KB", async () => {
    // The number that decides whether a parent on a mobile connection waits.
    const { variants } = await deriveVariants(await fullResPortrait(), {
      watermarkText: "O'Neills",
      only: ["thumb"],
    });
    const avif = variants.find((v) => v.format === "avif")!;
    expect(avif.bytes * 24).toBeLessThan(600_000);
  });

  it("can regenerate a single size without redoing the ladder", async () => {
    const { variants } = await deriveVariants(await portrait(800, 1200), {
      watermarkText: "O'Neills",
      only: ["thumb"],
    });
    expect(new Set(variants.map((v) => v.kind))).toEqual(new Set(["thumb"]));
  });
});

describe("watermark rendering", () => {
  it("escapes studio names containing XML characters", () => {
    // "Smith & Sons" would otherwise produce invalid SVG and fail the whole
    // import, at the customer whose name contains an ampersand.
    const svg = watermarkSvg(200, 200, "Smith & Sons <Photo>").toString();
    expect(svg).toContain("Smith &amp; Sons &lt;Photo&gt;");
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|apos;|quot;)/);
  });
});

describe("near-duplicate grouping", () => {
  it("scores a burst as similar and different children as different", async () => {
    const a = await portrait(600, 900);
    // A near-identical second frame of the same child: same scene, slightly
    // brighter, as a burst would be.
    const b = await sharp(a).modulate({ brightness: 1.03 }).jpeg({ quality: 92 }).toBuffer();
    const c = await sharp(a).flop().jpeg({ quality: 92 }).toBuffer();

    const [ha, hb, hc] = (await Promise.all([a, b, c].map(perceptualHash))) as [
      string, string, string,
    ];
    expect(hammingDistance(ha, hb)).toBeLessThanOrEqual(4);
    expect(hammingDistance(ha, hc)).toBeGreaterThan(hammingDistance(ha, hb));
  });
});
