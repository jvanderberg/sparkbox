import { z } from "zod";

export const imageCountLimit = 4;
export const imageByteLimit = 2 * 1024 * 1024;
export const imageTotalByteLimit = 4 * 1024 * 1024;
export const agentWireByteLimit = 6 * 1024 * 1024;
export const imageTypes = ["image/png", "image/jpeg", "image/webp"] as const;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function pngCrc(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let at = start; at < end; at++)
    crc = (crcTable[(crc ^ (bytes[at] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Inspect bytes, not a caller's MIME/dimension claims. No URLs, paths, SVG or
// decoder execution on the management host. The browser additionally decodes.
function dimensions(data: string, mime: (typeof imageTypes)[number]): [number, number] {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, length: number) =>
    String.fromCharCode(...bytes.subarray(at, at + length));
  if (mime === "image/png") {
    if (ascii(0, 8) !== "\x89PNG\r\n\x1a\n" || bytes.length < 45) throw Error();
    let at = 8;
    let size: [number, number] | undefined;
    let pixels = false;
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at);
      const type = ascii(at + 4, 4);
      if (at + length + 12 > bytes.length) throw Error();
      if (pngCrc(bytes, at + 4, at + 8 + length) !== view.getUint32(at + 8 + length)) throw Error();
      if (at === 8) {
        if (type !== "IHDR" || length !== 13) throw Error();
        size = [view.getUint32(at + 8), view.getUint32(at + 12)];
      }
      if (type === "IDAT" && length > 0) pixels = true;
      at += length + 12;
      if (type === "IEND") {
        if (length || at !== bytes.length || !pixels || !size) throw Error();
        return size;
      }
    }
  } else if (mime === "image/jpeg") {
    if (view.getUint16(0) !== 0xffd8 || view.getUint16(bytes.length - 2) !== 0xffd9) throw Error();
    let at = 2;
    let size: [number, number] | undefined;
    while (at + 4 < bytes.length) {
      if (bytes[at++] !== 0xff) throw Error();
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) throw Error();
      if ([0xc0, 0xc1, 0xc2].includes(marker ?? 0)) {
        if (length < 8) throw Error();
        size = [view.getUint16(at + 5), view.getUint16(at + 3)];
      }
      if (marker === 0xda && size) return size;
      at += length;
    }
  } else if (mime === "image/webp") {
    if (
      ascii(0, 4) !== "RIFF" ||
      ascii(8, 4) !== "WEBP" ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      throw Error();
    let at = 12;
    let size: [number, number] | undefined;
    let pixels = false;
    const u24 = (n: number) =>
      (bytes[n] ?? 0) + ((bytes[n + 1] ?? 0) << 8) + ((bytes[n + 2] ?? 0) << 16);
    while (at + 8 <= bytes.length) {
      const type = ascii(at, 4);
      const length = view.getUint32(at + 4, true);
      const start = at + 8;
      if (start + length > bytes.length) throw Error();
      if (type === "VP8X" && length === 10) {
        if ((bytes[start] ?? 0) & 2) throw Error(); // Animated images are not screenshots.
        size = [u24(start + 4) + 1, u24(start + 7) + 1];
      } else if (type === "VP8 " && length >= 10) {
        if (ascii(start + 3, 3) !== "\x9d\x01\x2a") throw Error();
        size ??= [
          view.getUint16(start + 6, true) & 0x3fff,
          view.getUint16(start + 8, true) & 0x3fff,
        ];
        pixels = true;
      } else if (type === "VP8L" && length >= 5) {
        if (bytes[start] !== 0x2f) throw Error();
        const bits = view.getUint32(start + 1, true);
        size ??= [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
        pixels = true;
      }
      at = start + length + (length % 2);
    }
    if (at === bytes.length && size && pixels) return size;
  }
  throw Error();
}

export function decodedImageBytes(data: string) {
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
export const agentImageSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string().min(1).max(160),
    mime: z.enum(imageTypes),
    data: z
      .string()
      .min(4)
      .max(Math.ceil(imageByteLimit / 3) * 4),
  })
  .superRefine((image, ctx) => {
    try {
      if (
        !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
        image.data.length % 4 !== 0 ||
        decodedImageBytes(image.data) > imageByteLimit ||
        btoa(atob(image.data)) !== image.data
      )
        throw Error();
      const [width, height] = dimensions(image.data, image.mime);
      if (!width || !height || width > 8000 || height > 8000 || width * height > 25000000)
        throw Error();
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "Use a valid PNG, JPEG or WebP image under 2 MiB, 8,000 pixels per side and 25 megapixels.",
      });
    }
  });
export const agentImagesSchema = z
  .array(agentImageSchema)
  .max(imageCountLimit)
  .superRefine((images, ctx) => {
    if (images.reduce((sum, image) => sum + decodedImageBytes(image.data), 0) > imageTotalByteLimit)
      ctx.addIssue({ code: "custom", message: "Images must total 4 MiB or less." });
    if (new Set(images.map((image) => image.id)).size !== images.length)
      ctx.addIssue({ code: "custom", message: "Remove duplicate images." });
  });
export type AgentImage = z.infer<typeof agentImageSchema>;
export function imageDataUrl(image: AgentImage) {
  return `data:${image.mime};base64,${image.data}`;
}
