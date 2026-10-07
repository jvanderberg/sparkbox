// Attachment geometry adapted from T3 Code ChatComposer.tsx (MIT; vendor/t3code/LICENSE.txt).
import { X } from "lucide-react";
import {
  type AgentImage,
  agentImageSchema,
  imageByteLimit,
  imageDataUrl,
  imageTypes,
} from "./agents/images.ts";
import "./agent-images.css";

/** Longest edge the models make use of; larger images only cost tokens. */
const longestEdge = 1568;

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be opened. Try a PNG, JPEG, WebP, GIF or HEIC file.");
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

async function base64Of(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/**
 * Accept any image the browser can decode. Files that are already small
 * PNG/JPEG/WebP go through untouched; everything else is drawn to a canvas,
 * scaled to at most 1568px on the long edge and encoded as JPEG, shrinking
 * quality until it fits the per-image budget. Users never see a size limit.
 */
export async function readAgentImage(file: File): Promise<AgentImage> {
  if (file.type && !file.type.startsWith("image/")) throw new Error("Attach an image file.");
  const bitmap = await decode(file);
  const keep =
    imageTypes.some((type) => type === file.type) &&
    file.size <= imageByteLimit &&
    Math.max(bitmap.width, bitmap.height) <= longestEdge;
  let mime: (typeof imageTypes)[number] = "image/jpeg";
  let blob: Blob = file;
  if (keep) mime = file.type as (typeof imageTypes)[number];
  else {
    const scale = Math.min(1, longestEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot process images.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let encoded: Blob | null = null;
    for (const quality of [0.85, 0.75, 0.6, 0.45, 0.3]) {
      encoded = await toBlob(canvas, "image/jpeg", quality);
      if (encoded && encoded.size <= imageByteLimit) break;
    }
    if (!encoded) throw new Error("This image could not be converted.");
    blob = encoded;
  }
  bitmap.close();
  const parsed = agentImageSchema.safeParse({
    id: crypto.randomUUID(),
    name: file.name.slice(0, 160) || "Image",
    mime,
    data: await base64Of(blob),
  });
  if (!parsed.success) throw new Error("This image could not be attached. Try another file.");
  return parsed.data;
}

export function AgentImages({
  images,
  onRemove,
  disabled = false,
}: {
  images: AgentImage[];
  onRemove?: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <section className="chat-images" aria-label={onRemove ? "Attached images" : "Sent images"}>
      {images.map((image) => (
        <div key={image.id} className="chat-image">
          <img src={imageDataUrl(image)} alt={image.name} title={image.name} />
          {onRemove && (
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove ${image.name}`}
              onClick={() => onRemove(image.id)}
            >
              <X size={16} />
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
