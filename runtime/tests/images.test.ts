import { test, expect, describe } from "bun:test";
import { ImagesBinding } from "../bindings/images";

function toStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

// --- Minimal valid image buffers ---

// 1x1 white PNG
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length
  0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, // width: 1
  0x00, 0x00, 0x00, 0x01, // height: 1
  0x08, 0x02,             // bit depth 8, color type 2 (RGB)
  0x00, 0x00, 0x00,       // compression, filter, interlace
  0x90, 0x77, 0x53, 0xde, // CRC
]);

// Minimal JPEG (SOI + SOF0 frame)
function makeJpeg(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(20);
  const view = new DataView(buf.buffer);
  buf[0] = 0xff; buf[1] = 0xd8; // SOI
  buf[2] = 0xff; buf[3] = 0xc0; // SOF0
  view.setUint16(4, 14);         // segment length
  buf[6] = 8;                     // precision
  view.setUint16(7, height);
  view.setUint16(9, width);
  buf[11] = 3;                    // num components
  return buf;
}

// Minimal GIF89a
function makeGif(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(13);
  const view = new DataView(buf.buffer);
  buf[0] = 0x47; buf[1] = 0x49; buf[2] = 0x46; // GIF
  buf[3] = 0x38; buf[4] = 0x39; buf[5] = 0x61; // 89a
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return buf;
}

// Simple SVG
function makeSvg(width: number, height: number): Uint8Array {
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="1" height="1"/></svg>`;
  return new TextEncoder().encode(xml);
}

// SVG with viewBox only
function makeSvgViewBox(vw: number, vh: number): Uint8Array {
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}"><rect width="1" height="1"/></svg>`;
  return new TextEncoder().encode(xml);
}

let images: ImagesBinding;

describe("ImagesBinding", () => {
  images = new ImagesBinding();

  describe("info()", () => {
    test("PNG dimensions and format", async () => {
      const info = await images.info(toStream(PNG_1X1));
      expect(info.format).toBe("image/png");
      expect(info.width).toBe(1);
      expect(info.height).toBe(1);
      expect(info.fileSize).toBe(PNG_1X1.byteLength);
    });

    test("JPEG dimensions and format", async () => {
      const jpeg = makeJpeg(320, 240);
      const info = await images.info(toStream(jpeg));
      expect(info.format).toBe("image/jpeg");
      expect(info.width).toBe(320);
      expect(info.height).toBe(240);
      expect(info.fileSize).toBe(jpeg.byteLength);
    });

    test("GIF dimensions and format", async () => {
      const gif = makeGif(100, 50);
      const info = await images.info(toStream(gif));
      expect(info.format).toBe("image/gif");
      expect(info.width).toBe(100);
      expect(info.height).toBe(50);
    });

    test("SVG with width/height attributes", async () => {
      const svg = makeSvg(800, 600);
      const info = await images.info(toStream(svg));
      expect(info.format).toBe("image/svg+xml");
      expect(info.width).toBe(800);
      expect(info.height).toBe(600);
    });

    test("SVG with viewBox only", async () => {
      const svg = makeSvgViewBox(1024, 768);
      const info = await images.info(toStream(svg));
      expect(info.format).toBe("image/svg+xml");
      expect(info.width).toBe(1024);
      expect(info.height).toBe(768);
    });

    test("unknown format throws", async () => {
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
      await expect(images.info(toStream(garbage))).rejects.toThrow("Unsupported or unrecognizable image format");
    });

    test("fileSize matches input length", async () => {
      const jpeg = makeJpeg(10, 10);
      const info = await images.info(toStream(jpeg));
      expect(info.fileSize).toBe(jpeg.byteLength);
    });
  });

  describe("input() / transform / output", () => {
    test("passthrough returns original data", async () => {
      const data = PNG_1X1;
      const result = await images.input(toStream(data)).output({ format: "image/png" });
      expect(result.contentType()).toBe("image/png");
      const outputBuf = await readStreamToBuffer(result.image());
      expect(outputBuf).toEqual(data);
    });

    test("transform() is chainable", async () => {
      const transformer = images.input(toStream(PNG_1X1));
      const chained = transformer
        .transform({ width: 100, height: 100 })
        .transform({ rotate: 90 })
        .transform({ blur: 5 });
      const result = await chained.output({ format: "image/jpeg" });
      expect(result.contentType()).toBe("image/jpeg");
    });

    test("output format determines contentType", async () => {
      const result = await images
        .input(toStream(PNG_1X1))
        .output({ format: "image/webp" });
      expect(result.contentType()).toBe("image/webp");
    });

    test("draw() is chainable", async () => {
      const overlay = toStream(PNG_1X1);
      const result = await images
        .input(toStream(PNG_1X1))
        .draw(overlay, { top: 0, left: 0, opacity: 0.5 })
        .output({ format: "image/png" });
      expect(result.contentType()).toBe("image/png");
    });

    test("output().image() returns a readable stream", async () => {
      const result = await images.input(toStream(PNG_1X1)).output({ format: "image/png" });
      const stream = result.image();
      expect(stream).toBeInstanceOf(ReadableStream);
      const buf = await readStreamToBuffer(stream);
      expect(buf.byteLength).toBeGreaterThan(0);
    });
  });
});

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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
