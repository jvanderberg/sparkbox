// Extracted from T3 Code ComposerBanner.tsx (MIT; see LICENSE.txt).
// Retains the upstream attachment surface, outline and overlap; unused disclosure helpers omitted.
import type { ComponentProps } from "react";
import { cn } from "./utils.ts";
export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning";

const surfaceColors = cn(
  "[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--card))]",
  "dark:[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--surface-raised))]",
  "[html[data-theme-id]_&]:[--chat-composer-attached-surface:var(--app-theme-surface-raised)]",
);

const neutralOutline = cn(
  "[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--contrast-foreground)_8%,transparent))]",
  "dark:[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--color-white)_5%,transparent))]",
  "[html[data-theme-id]_&]:[--chat-composer-attached-outline:var(--chat-composer-outline,var(--app-theme-toolbar-border))]",
  "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--app-theme-input)_30%,var(--background)))]",
  "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-attached-outline:#241e28]",
);

const variantColors: Record<ComposerBannerVariant, string> = {
  default: neutralOutline,
  error:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--error)_32%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--error)_8%,transparent)]",
  info: neutralOutline,
  success: neutralOutline,
  warning:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--warning)_28%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--warning)_8%,transparent)]",
};

/** Shared glass and attachment seam, also used by the command menu without banner row padding. */
function Surface({
  placement = "attached",
  variant = "default",
  className,
  ...props
}: ComponentProps<"div"> & {
  placement?: "attached" | "floating";
  variant?: ComposerBannerVariant;
}) {
  return (
    <div
      data-composer-banner-surface={placement}
      data-variant={variant}
      className={cn(
        surfaceColors,
        "relative isolate border-0 bg-transparent shadow-none [--chat-composer-attached-tint:transparent]",
        variantColors[variant],
        placement === "attached"
          ? "[--chat-composer-attachment-overlap:calc(1rem+1px)] before:rounded-t-[16px]"
          : "[--chat-composer-attachment-overlap:0px] before:rounded-[1rem]",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:border before:border-(--chat-composer-attached-outline)",
        "before:bg-[color-mix(in_srgb,var(--chat-composer-attached-surface)_var(--glass-opacity),transparent)] before:bg-[linear-gradient(var(--chat-composer-attached-tint),var(--chat-composer-attached-tint))] before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        // The mask cut-off bleeds one pixel past the seam: Chromium drops the last
        // device-pixel row of a filtered backdrop when the cut-off lands off the
        // device-pixel grid, and the composer's surface starts exactly there. The
        // composer's own glass covers the extra row, so the overlap never shows.
        "before:mask-[linear-gradient(to_top,transparent_0_calc(var(--chat-composer-attachment-overlap)-1px),black_calc(var(--chat-composer-attachment-overlap)-1px))] before:shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] dark:before:shadow-[0_14px_32px_-18px_rgb(0_0_0/75%)]",
        "dark:supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:before:bg-[linear-gradient(var(--chat-composer-attached-tint),var(--chat-composer-attached-tint)),linear-gradient(to_top,transparent_0_var(--chat-composer-attachment-overlap),rgb(0_0_0/18%)_var(--chat-composer-attachment-overlap),transparent_calc(var(--chat-composer-attachment-overlap)+10px))]",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-attached-surface)",
        className,
      )}
      {...props}
    />
  );
}

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-banner-attachment"
      className={cn(
        "mx-auto -mb-[calc(1rem+1px)] w-[calc(100%-2*var(--chat-composer-drawer-inset))]",
        // Adjacent attachments share their outline, including notices outside the form.
        "[&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:rounded-none [&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:border-t-0",
        "[&+:has([data-chat-composer-form])_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:rounded-none [&+:has([data-chat-composer-form])_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:border-t-0",
        className,
      )}
      {...props}
    />
  );
}

function Root({
  className,
  density = "default",
  placement = "attached",
  variant = "default",
  width = "fill",
  ...props
}: ComponentProps<"div"> & {
  density?: "default" | "comfortable";
  placement?: "attached" | "floating";
  variant?: ComposerBannerVariant;
  width?: "fill" | "content";
}) {
  return (
    <Surface
      className={cn(
        "min-w-0 px-1 pt-(--composer-banner-padding-block) pb-[calc(var(--chat-composer-attachment-overlap)+var(--composer-banner-padding-block))] text-xs/4 [--composer-banner-icon-column:--spacing(7)] [--composer-banner-padding-block:--spacing(1)] sm:[--composer-banner-icon-column:--spacing(6)]",
        density === "comfortable" && "[--composer-banner-padding-block:--spacing(1.25)]",
        width === "content" ? "w-fit max-w-full flex-none" : "@container",
        className,
      )}
      data-slot="composer-banner"
      placement={placement}
      data-composer-banner-width={width}
      variant={variant}
      {...props}
    />
  );
}

export const ComposerBanner = { Attachment, Root };
