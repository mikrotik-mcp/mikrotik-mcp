import type { Metadata } from "next";

const description = "RouterOS tools, operational workflows and dashboard guides for MikroTik MCP.";
const siteUrl =
  process.env.SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:4000");
const image = {
  url: "/brand/social-preview.png",
  width: 1280,
  height: 640,
  alt: "MikroTik MCP — Network operations, explained.",
};

export const siteMetadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "MikroTik MCP — Network operations, explained.",
    template: "%s | MikroTik MCP",
  },
  description,
  openGraph: {
    type: "website",
    siteName: "MikroTik MCP",
    title: "MikroTik MCP — Network operations, explained.",
    description,
    images: [image],
  },
  twitter: {
    card: "summary_large_image",
    title: "MikroTik MCP — Network operations, explained.",
    description,
    images: [image],
  },
};
