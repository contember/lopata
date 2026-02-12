// Images binding — minimal viable implementation
// Real image transformations are not applied in dev mode;
// info() reads image headers for dimensions/format, transform() is a passthrough.

type ImageFormat = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "image/svg+xml";

export interface ImageInfo {
  width: number;
  height: number;
  format: ImageFormat;
  fileSize: number;
}

export interface ImageTransformOptions {
  width?: number;
  height?: number;
  fit?: "contain" | "cover" | "crop" | "scale-down" | "pad";
  rotate?: 0 | 90 | 180 | 270;
  blur?: number;
  brightness?: number;
  contrast?: number;
  sharpen?: number;
  trim?: { top?: number; right?: number; bottom?: number; left?: number };
  flip?: boolean;
  flop?: boolean;
  background?: string;
}

export interface DrawOptions {
  top?: number;
  left?: number;
  opacity?: number;
}

export interface OutputOptions {
  format: "image/png" | "image/jpeg" | "image/webp" | "image/avif";
  quality?: number;
}

export interface ImageOutputResult {
  image(): ReadableStream<Uint8Array>;
  contentType(): string;
}

// --- PNG header parsing ---

function parsePngSize(buf: Uint8Array): { width: number; height: number } | null {
  // PNG signature: 137 80 78 71 13 10 26 10
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  // IHDR chunk starts at byte 8; width at 16, height at 20 (big-endian u32)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// --- JPEG header parsing ---

function parseJpegSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1]!;
    // SOF markers: C0-C3, C5-C7, C9-CB, CD-CF
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (offset + 9 > buf.length) return null;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return { width, height };
    }
    const segLen = view.getUint16(offset + 2);
    offset += 2 + segLen;
  }
  return null;
}

// --- GIF header parsing ---

function parseGifSize(buf: Uint8Array): { width: number; height: number } | null {
  // GIF87a or GIF89a
  if (buf.length < 10) return null;
  if (buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

// --- WebP header parsing ---

function parseWebpSize(buf: Uint8Array): { width: number; height: number } | null {
  // RIFF....WEBP
  if (buf.length < 30) return null;
  if (buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46) return null;
  if (buf[8] !== 0x57 || buf[9] !== 0x45 || buf[10] !== 0x42 || buf[11] !== 0x50) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // VP8 lossy
  if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
    // Frame tag at offset 26
    if (buf.length < 30) return null;
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return { width, height };
  }
  // VP8L lossless
  if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4c) {
    if (buf.length < 25) return null;
    // Signature byte at 21, then 4 bytes with packed width/height
    const b0 = buf[21]!;
    const b1 = buf[22]!;
    const b2 = buf[23]!;
    const b3 = buf[24]!;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 >> 6) & 0x03));
    return { width, height };
  }
  // VP8X extended
  if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
    if (buf.length < 30) return null;
    const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
    const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
    return { width, height };
  }
  return null;
}

// --- SVG parsing ---

function parseSvgSize(text: string): { width: number; height: number } | null {
  const svgMatch = text.match(/<svg[^>]*>/i);
  if (!svgMatch) return null;
  const tag = svgMatch[0];
  // Try width/height attributes
  const wMatch = tag.match(/\bwidth\s*=\s*"(\d+)(?:px)?"/);
  const hMatch = tag.match(/\bheight\s*=\s*"(\d+)(?:px)?"/);
  if (wMatch?.[1] && hMatch?.[1]) {
    return { width: parseInt(wMatch[1], 10), height: parseInt(hMatch[1], 10) };
  }
  // Try viewBox
  const vbMatch = tag.match(/\bviewBox\s*=\s*"([^"]+)"/);
  if (vbMatch?.[1]) {
    const parts = vbMatch[1].trim().split(/[\s,]+/);
    if (parts.length >= 4) {
      return { width: Math.round(parseFloat(parts[2]!)), height: Math.round(parseFloat(parts[3]!)) };
    }
  }
  return null;
}

// --- Detect format from bytes ---

function detectFormat(buf: Uint8Array): ImageFormat | null {
  if (buf.length < 4) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  // RIFF...WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // AVIF: ftyp box with 'avif' or 'avis' brand
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8]!, buf[9]!, buf[10]!, buf[11]!);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  // SVG — check for XML / <svg
  const start = new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 256)));
  if (start.includes("<svg") || start.includes("<?xml")) return "image/svg+xml";
  return null;
}

// --- Parse dimensions ---

function parseDimensions(buf: Uint8Array, format: ImageFormat): { width: number; height: number } | null {
  switch (format) {
    case "image/png":
      return parsePngSize(buf);
    case "image/jpeg":
      return parseJpegSize(buf);
    case "image/gif":
      return parseGifSize(buf);
    case "image/webp":
      return parseWebpSize(buf);
    case "image/svg+xml":
      return parseSvgSize(new TextDecoder().decode(buf));
    case "image/avif":
      // AVIF dimension parsing is complex (HEIF container); return null
      return null;
    default:
      return null;
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.byteLength;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// --- ImageTransformer ---

class LocalImageTransformer {
  private data: Uint8Array;
  private transforms: ImageTransformOptions[] = [];
  private overlays: { data: Uint8Array; options?: DrawOptions }[] = [];
  private warned = false;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  transform(options: ImageTransformOptions): LocalImageTransformer {
    this.transforms.push(options);
    this._warn();
    return this;
  }

  draw(image: ReadableStream<Uint8Array>, options?: DrawOptions): LocalImageTransformer {
    // We can't synchronously read the stream here, so we store a placeholder.
    // The actual read happens in output().
    this.overlays.push({ data: new Uint8Array(0), options });
    this._warn();
    return this;
  }

  async output(options: OutputOptions): Promise<ImageOutputResult> {
    if (this.transforms.length > 0 || this.overlays.length > 0) {
      this._warn();
    }
    const data = this.data;
    const contentType = options.format;
    return {
      image(): ReadableStream<Uint8Array> {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        });
      },
      contentType(): string {
        return contentType;
      },
    };
  }

  private _warn() {
    if (!this.warned) {
      this.warned = true;
      console.warn("[bunflare] Image transformations are not applied in dev mode — returning original image");
    }
  }
}

// --- ImagesBinding ---

export class ImagesBinding {
  async info(stream: ReadableStream<Uint8Array>): Promise<ImageInfo> {
    const buf = await readStream(stream);
    const format = detectFormat(buf);
    if (!format) {
      throw new Error("Unsupported or unrecognizable image format");
    }
    const dims = parseDimensions(buf, format);
    return {
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
      format,
      fileSize: buf.byteLength,
    };
  }

  input(stream: ReadableStream<Uint8Array>): LocalImageTransformer {
    // We need the data synchronously for the transformer chain, so we return
    // a proxy-like object. The real read happens lazily.
    // However, to keep it simple, we eagerly consume the stream.
    // Since `input()` must return synchronously, we store a promise.
    const transformer = new LazyImageTransformer(stream);
    return transformer as unknown as LocalImageTransformer;
  }
}

// LazyImageTransformer: wraps stream reading so input() can return synchronously
class LazyImageTransformer {
  private streamPromise: Promise<Uint8Array>;
  private transforms: ImageTransformOptions[] = [];
  private warned = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.streamPromise = readStream(stream);
  }

  transform(options: ImageTransformOptions): LazyImageTransformer {
    this.transforms.push(options);
    this._warn();
    return this;
  }

  draw(_image: ReadableStream<Uint8Array>, _options?: DrawOptions): LazyImageTransformer {
    this._warn();
    return this;
  }

  async output(options: OutputOptions): Promise<ImageOutputResult> {
    const data = await this.streamPromise;
    if (this.transforms.length > 0) {
      this._warn();
    }
    const contentType = options.format;
    return {
      image(): ReadableStream<Uint8Array> {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        });
      },
      contentType(): string {
        return contentType;
      },
    };
  }

  private _warn() {
    if (!this.warned) {
      this.warned = true;
      console.warn("[bunflare] Image transformations are not applied in dev mode — returning original image");
    }
  }
}
