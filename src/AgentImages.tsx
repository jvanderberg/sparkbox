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

export async function readAgentImage(file: File): Promise<AgentImage> {
  if (!imageTypes.some((type) => type === file.type))
    throw new Error("Attach a PNG, JPEG or WebP image.");
  if (file.size > imageByteLimit) throw new Error("Each image must be 2 MiB or less.");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read this image. Try selecting it again."));
    reader.readAsDataURL(file);
  });
  const parsed = agentImageSchema.safeParse({
    id: crypto.randomUUID(),
    name: file.name.slice(0, 160) || "Screenshot",
    mime: file.type,
    data,
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid image.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
  } catch {
    throw new Error("This image could not be opened. Try another PNG, JPEG or WebP image.");
  } finally {
    URL.revokeObjectURL(url);
  }
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
