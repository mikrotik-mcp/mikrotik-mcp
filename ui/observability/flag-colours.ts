/**
 * The colours of a country's flag, read from the flag's own SVG. The dashboard
 * paints them as a soft wash behind a router, so the page needs the colours and
 * not the picture.
 */
import { useEffect, useState } from "react";
import { withToken } from "./api";

/** Red, green and blue of a `#rgb` or `#rrggbb` colour. */
function channels(hex: string): [number, number, number] {
  const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, "$&$&") : hex;
  const n = Number.parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

/**
 * Up to three colours of a flag SVG, in the order the flag draws them. White,
 * black and greys are left out when the flag has two colours without them: on
 * a dark or light ground they only wash the others out.
 */
export function flagPalette(svg: string): string[] {
  const all = [...svg.matchAll(/fill="(#(?:[0-9a-f]{3}|[0-9a-f]{6}))"/gi)].map((m) =>
    m[1]!.toLowerCase(),
  );
  const unique = [...new Set(all)];
  const vivid = unique.filter((hex) => {
    const [r, g, b] = channels(hex);
    return Math.max(r, g, b) - Math.min(r, g, b) > 40;
  });
  return (vivid.length >= 2 ? vivid : unique).slice(0, 3);
}

const cache = new Map<string, Promise<string[]>>();

/** The palette of each country code, as it arrives. A code with no flag has none. */
export function useFlagPalettes(codes: readonly string[]): Record<string, string[]> {
  const [palettes, setPalettes] = useState<Record<string, string[]>>({});
  const key = [...new Set(codes)].sort().join(",");
  useEffect(() => {
    let alive = true;
    for (const code of key ? key.split(",") : []) {
      let wait = cache.get(code);
      if (!wait) {
        wait = fetch(withToken(`/api/flag/${code}`))
          .then((res) => (res.ok ? res.text() : ""))
          .then(flagPalette)
          .catch(() => []);
        cache.set(code, wait);
      }
      void wait.then((colours) => {
        if (alive && colours.length > 0) setPalettes((p) => ({ ...p, [code]: colours }));
      });
    }
    return () => {
      alive = false;
    };
  }, [key]);
  return palettes;
}
