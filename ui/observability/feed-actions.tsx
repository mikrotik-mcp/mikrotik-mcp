import { FileJson, FileSpreadsheet, ListFilter, Pause, Play, Trash2 } from "lucide-react";
import { ExpandableActionBar } from "./components/beui/registry/components/motion/expandable-action-bar";

/** Selection-aware actions; deletion only opens the existing confirmation. */
export function FeedActions({
  paused,
  count,
  onPause,
  onExport,
  onClear,
  onDelete,
}: {
  paused: boolean;
  count: number;
  onPause: () => void;
  onExport: (format: "csv" | "json") => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  return (
    <div role="group" aria-label="Live Feed actions" className="max-w-full">
      <ExpandableActionBar
        size="sm"
        classNames={{
          track: "rounded-xl shadow-none",
          item: "rounded-lg focus-visible:ring-2 focus-visible:ring-ring",
        }}
        items={[
          {
            id: "pause",
            label: paused ? "Resume" : "Pause",
            icon: paused ? <Play /> : <Pause />,
            active: paused,
            onClick: onPause,
          },
          {
            id: "csv",
            label: "Export CSV",
            icon: <FileSpreadsheet />,
            badge: count || undefined,
            onClick: () => onExport("csv"),
          },
          {
            id: "json",
            label: "Export JSON",
            icon: <FileJson />,
            badge: count || undefined,
            onClick: () => onExport("json"),
          },
          { id: "clear", label: "Clear filters", icon: <ListFilter />, onClick: onClear },
          {
            id: "delete",
            label: "Delete selected",
            icon: <Trash2 />,
            badge: count || undefined,
            disabled: count === 0,
            onClick: onDelete,
          },
        ]}
      />
    </div>
  );
}
