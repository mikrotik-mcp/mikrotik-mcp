/**
 * Storage tools: one drawer with four tabs, opened from the toolbar. Storage
 * analysis, the vault, the recycle bin and scheduled collection.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { StorageTab } from "./files-analysis";
import { JobsTab } from "./files-jobs";
import { analysisStore, filePanes, jobsStore, trashStore, vaultStore } from "./files-lib";
import { activePaneStore, box } from "./files-parts";
import { TrashTab } from "./files-trash";
import { VaultTab } from "./files-vault";
import { presetWidth } from "./files-viewer";
import type { DrawerTab } from "./kit";
import { RowDrawer } from "./kit";

export type ToolTab = "storage" | "vault" | "trash" | "jobs";
const KEY = "files-tools";

/** What the toolbar chips count: files in the vault, jobs, files in the bin. */
export const toolCounts = box<{ vault?: number; jobs?: number; trash?: number }>({});

/** Opens the drawer on one tab. Storage opens on the router of the last used pane. */
export function openTool(tab: ToolTab, device?: string): void {
  if (tab === "storage") {
    const target = device ?? activePaneStore.get()?.device ?? filePanes.all()[0]?.device ?? "";
    analysisStore.set(target);
  } else analysisStore.set(null);
  vaultStore.set(tab === "vault");
  trashStore.set(tab === "trash");
  jobsStore.set(tab === "jobs");
}

export function closeTools(): void {
  analysisStore.set(null);
  vaultStore.set(false);
  trashStore.set(false);
  jobsStore.set(false);
}

export function ToolsDrawer({
  readOnly,
  trash,
  routers,
}: {
  readOnly: boolean;
  trash: boolean;
  routers: string[];
}): ReactNode {
  const device = useSyncExternalStore(analysisStore.subscribe, analysisStore.get);
  const vault = useSyncExternalStore(vaultStore.subscribe, vaultStore.get);
  const bin = useSyncExternalStore(trashStore.subscribe, trashStore.get);
  const jobs = useSyncExternalStore(jobsStore.subscribe, jobsStore.get);
  const counts = useSyncExternalStore(toolCounts.subscribe, toolCounts.get);
  const tab: ToolTab | null =
    device !== null ? "storage" : vault ? "vault" : bin ? "trash" : jobs ? "jobs" : null;
  const [storageDevice, setStorageDevice] = useState<string | null>(null);
  useEffect(() => {
    if (device) setStorageDevice(device);
  }, [device]);

  const setCount = useCallback(
    (key: "vault" | "jobs" | "trash") => (n: number) =>
      toolCounts.set({ ...toolCounts.get(), [key]: n }),
    [],
  );
  const [onVault] = useState(() => setCount("vault"));
  const [onTrash] = useState(() => setCount("trash"));
  const [onJobs] = useState(() => setCount("jobs"));

  if (!tab) return null;
  presetWidth(KEY);
  const tabs: DrawerTab[] = [
    {
      id: "storage",
      label: "Storage",
      content: <StorageTab device={storageDevice ?? device} readOnly={readOnly} />,
    },
    {
      id: "vault",
      label: "Vault",
      count: counts.vault,
      content: <VaultTab readOnly={readOnly} onCount={onVault} />,
    },
    ...(trash
      ? [
          {
            id: "trash",
            label: "Recycle bin",
            count: counts.trash,
            content: <TrashTab readOnly={readOnly} onCount={onTrash} />,
          },
        ]
      : []),
    {
      id: "jobs",
      label: "Scheduled",
      count: counts.jobs,
      content: <JobsTab routers={routers} onCount={onJobs} />,
    },
  ];
  return (
    <RowDrawer
      open
      onClose={closeTools}
      label="Storage tools"
      storageKey={KEY}
      title="Storage tools"
      meta="Storage, vault, recycle bin and scheduled collection"
      rowKey={tab}
      tabs={tabs}
      tab={tab}
      onTab={(id) => openTool(id as ToolTab, storageDevice ?? undefined)}
    />
  );
}
