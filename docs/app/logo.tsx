import Image from "next/image";

/** Render the canonical project mark without duplicating its SVG paths. */
export function Logo({ size = 32 }: { size?: number }) {
  return <Image src="/brand/logo-icon.svg" alt="" width={size} height={size} unoptimized />;
}
