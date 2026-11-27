import { useRef, useState } from "react";
import type { ReactNode } from "react";

export function usePaneSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
    } catch {
      /* The pane remains adjustable without storage. */
    }
    return initial;
  });
  return {
    size,
    min,
    max,
    resize(value: number) {
      const next = Math.max(min, Math.min(max, Math.round(value)));
      setSize(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        /* Session only. */
      }
    },
    reset: () => {
      setSize(initial);
      try {
        localStorage.removeItem(key);
      } catch {
        /* Session only. */
      }
    },
  };
}

export function PaneDivider({
  pane,
  label,
  controls,
  percent = false,
}: {
  pane: ReturnType<typeof usePaneSize>;
  label: string;
  controls: string;
  percent?: boolean;
}): ReactNode {
  const start = useRef<{ x: number; size: number; scale: number } | null>(null);
  return (
    <div
      className="pane-divider"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      aria-valuenow={pane.size}
      aria-valuetext={pane.size + (percent ? "%" : " pixels")}
      title={`${label} · Drag or use arrow keys · Double-click to reset`}
      onDoubleClick={pane.reset}
      onKeyDown={(event) => {
        const step = percent ? 2 : 16;
        const values: Record<string, number> = {
          ArrowLeft: pane.size - step,
          ArrowRight: pane.size + step,
          Home: pane.min,
          End: pane.max,
        };
        const next = values[event.key];
        if (next === undefined) return;
        event.preventDefault();
        pane.resize(next);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        const width = event.currentTarget.parentElement!.getBoundingClientRect().width;
        start.current = { x: event.clientX, size: pane.size, scale: percent ? 100 / width : 1 };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!start.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        pane.resize(start.current.size + (event.clientX - start.current.x) * start.current.scale);
      }}
      onLostPointerCapture={() => {
        start.current = null;
      }}
    />
  );
}
