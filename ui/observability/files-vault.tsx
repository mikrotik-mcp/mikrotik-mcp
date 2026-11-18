/**
 * The backup vault of the server: the files saved from routers (and the backups
 * of the Backups page). Send a file to the open folder of any pane.
 */
import { Send, Vault } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { VaultFile } from "./files-lib";
import { filePanes, filesApi, kindOf } from "./files-lib";
import { KindTile, Strip, size } from "./files-parts";
import { RowMenu, SearchInput, Select } from "./kit";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `Nov 18, 03:00` from a millisecond time. */
export function at(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${two(d.getDate())}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function VaultTab({
  readOnly,
  onCount,
}: {
  readOnly: boolean;
  onCount?: (n: number) => void;
}): ReactNode {
  const panes = useSyncExternalStore(filePanes.subscribe, filePanes.all);
  const [vault, setVault] = useState<{ dir: string; files: VaultFile[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const target = panes.find((pane) => pane.id === targetId) ?? panes[0];

  useEffect(() => {
    setMessage(null);
    filesApi
      .vault()
      .then((answer) => {
        setVault(answer);
        onCount?.(answer.files.length);
      })
      .catch((e: unknown) =>
        setMessage({ text: e instanceof Error ? e.message : String(e), bad: true }),
      );
  }, [onCount]);

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
    <div className="fl-tool">
      <div className="fl-tool-hd">
        <Vault size={16} aria-hidden="true" />
        <h3>Vault</h3>
        {vault && (
          <span className="m">
            {vault.dir} · {vault.files.length} {vault.files.length === 1 ? "file" : "files"}
          </span>
        )}
      </div>
      <div className="fl-tool-bar">
        <SearchInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter the vault"
          label="Filter the vault"
          wrapClassName="grow"
        />
        {!readOnly && target && (
          <Select
            label="Send to"
            className="fl-vault-to"
            value={target.id}
            options={panes.map((pane) => ({
              value: pane.id,
              label: `Send to ${pane.device} : ${pane.path}`,
            }))}
            onChange={setTargetId}
          />
        )}
      </div>
      {message && <Strip tone={message.bad ? "danger" : "ok"}>{message.text}</Strip>}
      {!vault && !message && <p className="fl-empty">Reading the vault…</p>}
      {vault && shown.length === 0 && (
        <p className="fl-empty">
          {vault.files.length === 0
            ? "The vault is empty. Select files in a pane and click Vault to save them here."
            : "No name matches the filter."}
        </p>
      )}
      {shown.map((file) => (
        <RowMenu
          key={file.name}
          title={file.name}
          sub={vault?.dir}
          copies={[{ label: "Name", value: file.name }]}
          actions={
            !readOnly && target
              ? [
                  {
                    label: `Send to ${target.device}:${target.path}`,
                    icon: <Send />,
                    onSelect: () => send(file),
                    disabled: busy !== "",
                  },
                ]
              : []
          }
        >
          <div className="fl-lr fl-vault-r">
            <span data-col="kind">
              <KindTile kind={kindOf({ name: file.name, dir: false })} size={13} />
            </span>
            <span data-col="name">
              <span className="n">{file.name}</span>
              <span className="m">
                {size(file.bytes)} · {at(file.modified)}
              </span>
            </span>
            {!readOnly && target ? (
              <button
                type="button"
                className="fp-act"
                disabled={busy !== ""}
                onClick={() => send(file)}
              >
                {busy === file.name ? "Sending…" : "Send"}
              </button>
            ) : (
              <span />
            )}
          </div>
        </RowMenu>
      ))}
    </div>
  );
}
