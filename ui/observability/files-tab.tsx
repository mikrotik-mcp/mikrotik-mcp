/**
 * The head of a Files pane, drawn as its dockview tab so panes still drag and
 * dock: router colour, health LED, name, architecture and version, close.
 */
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { fleetStore, swatch, usageStore } from "./files-parts";
import { Led } from "./kit";

export function FilesTab(props: IDockviewPanelHeaderProps<{ device?: string }>): ReactNode {
  const device = props.params.device ?? props.api.title ?? "";
  const fleet = useSyncExternalStore(fleetStore.subscribe, fleetStore.get);
  useSyncExternalStore(usageStore.subscribe, usageStore.version);
  const info = usageStore.get(device);
  const title = props.api.title ?? device;
  const extra = title !== device ? title.slice(device.length) : "";
  return (
    <div className="fp-tab">
      <span
        className="sw"
        style={{ background: swatch(fleet.names.indexOf(device)) }}
        aria-hidden="true"
      />
      <Led tone={fleet.tone[device] ?? "off"} />
      <span className="nm">
        {device}
        {extra}
      </span>
      {info?.arch && (
        <span className="m">
          {info.arch}
          {info.version && ` · ${info.version}`}
        </span>
      )}
      <span className="sp" />
      <button
        type="button"
        className="fp-ib"
        aria-label={`Close ${title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          props.api.close();
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
