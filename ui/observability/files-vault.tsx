/**
 * The backup vault of the server: the files saved from routers (and the backups
 * of the Backups page). Send a file to the open folder of any pane.
 */
import { Send, Vault, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { bytes } from "./format";
import { Select } from "./geist";
import type { VaultFile } from "./files-lib";
import { filePanes, filesApi, vaultStore } from "./files-lib";

export function VaultDialog({ readOnly }: { readOnly: boolean }): ReactNode {
  const open = useSyncExternalStore(vaultStore.subscribe, vaultStore.get);
  const panes = useSyncExternalStore(filePanes.subscribe, filePanes.all);
  const [vault, setVault] = useState<{ dir: string; files: VaultFile[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const target = panes.find((pane) => pane.id === targetId) ?? panes[0];

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    filesApi
      .vault()
      .then(setVault)
      .catch((e: unknown) =>
        setMessage({ text: e instanceof Error ? e.message : String(e), bad: true }),
      );
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") vaultStore.set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const shown = (vault?.files ?? []).filter((file) =>
    file.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const send = (file: VaultFile): void => {
    if (!target) return;
    setBusy(file.name);
    filesApi
      .sendFromVault(file.name, target.device, target.path)
      .then(() =>
        setMessage({ text: `${file.name} is now on ${target.device}:${target.path}.`, bad: false }),
      )
      .catch((e: unknown) =>
        setMessage({ text: e instanceof Error ? e.message : String(e), bad: true }),
      )
      .finally(() => setBusy(""));
  };

  return (
    <div className="term-modal" role="dialog" aria-modal="true" aria-label="Vault">
      <div className="term-modal-card files-sync">
        <header>
          <strong>
            <Vault size={15} /> Vault
          </strong>
          <span className="files-viewer-meta">{vault?.dir}</span>
          <button type="button" onClick={() => vaultStore.set(false)} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="files-sync-sides">
          <input
            className="files-filter files-vault-filter"
            value={filter}
            placeholder="Filter the vault"
            aria-label="Filter the vault"
            onChange={(event) => setFilter(event.target.value)}
          />
          {!readOnly && target && (
            <Select
              size="sm"
              className="term-select"
              aria-label="Send to"
              value={target.id}
              options={panes.map((pane) => ({
                value: pane.id,
                label: `Send to ${pane.device}:${pane.path}`,
              }))}
              onValueChange={setTargetId}
            />
          )}
        </div>
        {message && (
          <p className="files-empty" data-tone={message.bad ? "danger" : undefined}>
            {message.text}
          </p>
        )}
        {!vault && !message && <p className="files-empty">Reading the vault…</p>}
        {vault && shown.length === 0 && (
          <p className="files-empty">
            {vault.files.length === 0
              ? "The vault is empty. Select files in a pane and click Vault to save them here."
              : "No name matches the filter."}
          </p>
        )}
        <div className="files-sync-rows">
          {shown.map((file) => (
            <div key={file.name} className="files-sync-row files-trash-row">
              <span className="files-sync-mid">
                <strong title={file.name}>{file.name}</strong>
              </span>
              <span className="files-sync-cell">
                {bytes(file.bytes)} · {new Date(file.modified).toLocaleString()}
              </span>
              <span className="files-sync-mid">
                {!readOnly && target && (
                  <button type="button" disabled={busy !== ""} onClick={() => send(file)}>
                    <Send size={13} /> {busy === file.name ? "Sending…" : "Send"}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
