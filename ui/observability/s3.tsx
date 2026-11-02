import { LoadingState } from "./loading-state";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check, Cloud, Download, RefreshCw, Trash2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, postJson } from "./api";
import { Panel } from "./atoms";
import { bytes } from "./format";
import { Button } from "./geist";
import { toast } from "./toast-action";

// ── S3 backup management view ────────────────────────────────────────────────
interface S3Object {
  key: string;
  size: number;
  lastModified: string | null;
}
interface S3List {
  configured: boolean;
  target?: string;
  objects: S3Object[];
  truncated?: boolean;
}

/** List, download (presigned) and delete objects in the configured S3 bucket. */
export function S3Manage(): ReactNode {
  const [data, setData] = useState<S3List | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    void api<S3List>("/api/s3/list")
      .then(setData)
      .catch(() => setData({ configured: false, objects: [] }));
  }, []);
  useEffect(() => load(), [load]);

  const download = (key: string): void => {
    void api<{ url?: string }>(`/api/s3/presign?key=${encodeURIComponent(key)}`)
      .then((r) => {
        if (r.url) window.open(r.url, "_blank", "noopener");
        else {
          setMsg("could not generate download link");
          toast.error("Could not generate download link");
        }
      })
      .catch(() => {
        setMsg("could not generate download link");
        toast.error("Could not generate download link");
      });
  };
  const del = async (key: string): Promise<void> => {
    setBusy(key);
    const r = await postJson<{ ok?: boolean; error?: string }>("/api/s3/delete", { key }).catch(
      (): { ok?: boolean; error?: string } => ({ error: "request failed" }),
    );
    setBusy(null);
    setConfirm(null);
    if (r.ok) {
      setMsg(`Deleted ${key}`);
      toast.success("S3 object deleted");
      load();
    } else {
      setMsg(r.error ?? "delete failed");
      toast.error(r.error ?? "S3 object delete failed");
    }
  };

  if (!data) return <LoadingState label="Loading S3 objects" />;
  if (!data.configured) {
    return (
      <div className="grid justify-items-center gap-2 rounded-lg border border-dashed border-border px-4 py-[54px] text-center">
        <Cloud className="size-7 text-muted-foreground opacity-80" />
        <p className="m-0 font-semibold text-foreground">S3 is not configured</p>
        <p className="m-0 max-w-[460px] text-muted-foreground text-xs">
          Add an <code>s3</code> block (bucket + credentials) to your config to manage backup
          objects here.
        </p>
      </div>
    );
  }

  return (
    <section className="grid content-start gap-[18px]">
      <Panel
        title="S3 backups"
        className="reveal"
        extra={
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-[11px]">
              {data.target} · {data.objects.length} object{data.objects.length === 1 ? "" : "s"}
              {data.truncated ? " (truncated)" : ""}
            </span>
            <Button size="sm" ghost icon={<RefreshCw />} onClick={load}>
              Refresh
            </Button>
          </div>
        }
      >
        {msg && <div className="font-mono text-xs text-muted-foreground">{msg}</div>}
        {data.objects.length === 0 ? (
          <div className="p-3 text-muted-foreground text-[11px]">
            No objects in the bucket. Upload one with the <code>upload_backup_to_s3</code> tool.
          </div>
        ) : (
          <Table className="font-mono">
            <TableHeader>
              <TableRow>
                <TableHead>key</TableHead>
                <TableHead className="text-right tabular-nums">size</TableHead>
                <TableHead>modified</TableHead>
                <TableHead className="w-[200px]">actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.objects.map((o) => (
                <TableRow key={o.key}>
                  <TableCell>{o.key}</TableCell>
                  <TableCell className="text-right tabular-nums">{bytes(o.size)}</TableCell>
                  <TableCell>
                    {o.lastModified
                      ? new Date(o.lastModified).toLocaleString(undefined, { hour12: false })
                      : "—"}
                  </TableCell>
                  <TableCell className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" ghost icon={<Download />} onClick={() => download(o.key)}>
                      Download
                    </Button>
                    {confirm === o.key ? (
                      <>
                        <Button
                          size="sm"
                          type="error"
                          ghost
                          icon={<Check />}
                          disabled={busy === o.key}
                          onClick={() => void del(o.key)}
                        >
                          Confirm
                        </Button>
                        <Button size="sm" ghost onClick={() => setConfirm(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" ghost icon={<Trash2 />} onClick={() => setConfirm(o.key)}>
                        Delete
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </section>
  );
}
