import { createMDX } from "fumadocs-mdx/next";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Types
import type { NextConfig } from "next";

const withMDX = createMDX();
// Publish the canonical brand assets on both development and production builds.
mkdirSync(fileURLToPath(new URL("./public/brand/", import.meta.url)), { recursive: true });
for (const file of ["logo.svg", "logo-icon.svg", "social-preview.png"]) {
  copyFileSync(
    fileURLToPath(new URL(`../assets/${file}`, import.meta.url)),
    fileURLToPath(new URL(`./public/brand/${file}`, import.meta.url)),
  );
}
copyFileSync(
  fileURLToPath(new URL("../assets/logo-icon.svg", import.meta.url)),
  fileURLToPath(new URL("./app/icon.svg", import.meta.url)),
);
const nextConfig: NextConfig = {
  poweredByHeader: false,
  cleanDistDir: true,
  compress: true,
  generateEtags: true,
  reactStrictMode: true,
};

export default withMDX(nextConfig);
