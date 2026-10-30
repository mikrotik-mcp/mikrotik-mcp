import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Logo } from "./logo";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="site-brand">
        <Logo />
        <span>MikroTik MCP</span>
      </span>
    ),
  },
  githubUrl: "https://github.com/mikrotik-mcp/mikrotik-mcp",
  links: [
    { text: "Guides", url: "/docs/guides/getting-started" },
    { text: "Dashboard", url: "/docs/dashboard" },
    { text: "Tool reference", url: "/docs/reference" },
  ],
  themeSwitch: {
    enabled: true,
    mode: "light-dark",
  },
  searchToggle: {
    enabled: true,
  },
};
