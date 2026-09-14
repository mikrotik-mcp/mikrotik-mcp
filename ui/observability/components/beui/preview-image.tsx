import type { ComponentProps } from "react";

/** Offline illustration for the catalogue's Next/Image example; no third-party requests. */
export function PreviewImage({
  alt,
  className,
}: ComponentProps<"img"> & { fill?: boolean; sizes?: string }) {
  return (
    <div
      role="img"
      aria-label={alt}
      className={`grid h-full min-h-40 place-items-center bg-muted text-muted-foreground ${className ?? ""}`}
    >
      <span className="p-6 text-center text-sm">{alt}</span>
    </div>
  );
}
