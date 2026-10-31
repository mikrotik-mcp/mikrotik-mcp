import { Analytics } from "@vercel/analytics/next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { Inter, JetBrains_Mono, Manrope } from "next/font/google";
// Types
import type { ReactNode } from "react";
// Styles
import "./global.css";
export { siteMetadata as metadata } from "@root/lib/metadata";

const inter = Inter({
  subsets: ["latin"],
});

const display = Manrope({ subsets: ["latin"], variable: "--font-display" });

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.className} ${mono.variable} ${display.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider
          theme={{
            enableColorScheme: true,
            enabled: true,
            enableSystem: true,
            defaultTheme: "light",
          }}
        >
          {children}
        </RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
