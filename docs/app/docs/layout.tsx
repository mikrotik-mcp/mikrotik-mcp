import { source } from "@root/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import type { ReactNode } from "react";
import { baseOptions } from "@root/app/layout.config";

export default function RootDocsLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      tabMode="navbar"
      {...baseOptions}
      links={[]}
      nav={{ ...baseOptions.nav, mode: "top" }}
      containerProps={{ className: "docs-workspace" }}
    >
      {children}
    </DocsLayout>
  );
}
