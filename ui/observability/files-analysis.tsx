/**
 * Where the storage of a router goes: a block for each top folder sized by what
 * it holds, files that are usually safe to remove, and the largest files.
 * Nothing is deleted until the user confirms in the strip.
 */
import { Archive, ChartPie, ChevronDown, File, Scissors, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TreeFile } from "./files-lib";
import { analyzeDisk, filesApi, filesBus } from "./files-lib";
import { Strip, size, stamp, usageStore } from "./files-parts";
import { Checkbox, tipProps } from "./kit";

/** Block colours, largest first: indigo, amber, teal, then two greys. */
const BLOCK = ["acc", "warn", "sig", "g3", "g2"];

/** The board's words for each kind of suggestion. */
function suggestion(title: string, n: number): { name: string; why: string; icon: ReactNode } {
  if (title === "Old backups")
    return {
      name: `${n} old ${n === 1 ? "backup" : "backups"}`,
      why: "More than 30 days old. The newest 3 stay.",
      icon: <Archive size={15} />,
    };
  if (title === "Unfinished copies")
    return {
      name: `${n} unfinished ${n === 1 ? "copy" : "copies"}`,
      why: ".part files left by a stopped transfer.",
      icon: <Scissors size={15} />,
    };
  return {
    name: `${n} support ${n === 1 ? "output" : "outputs"}`,
    why: "supout.rif files you already sent.",
    icon: <File size={15} />,
  };
}

export function StorageTab({
  device,
  readOnly,
}: {
  device: string | null;
  readOnly: boolean;
}): ReactNode {
  const [tree, setTree] = useState<{ files: TreeFile[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useSyncExternalStore(usageStore.subscribe, usageStore.version);
  const usage = device ? usageStore.get(device) : undefined;

  useEffect(() => {
    setTree(null);
    setError("");
    setPicked(new Set());
    if (!device) return;
    let current = true;
    filesApi
      .tree(device, "/")
      .then((answer) => current && setTree(answer))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [device, round]);

  const report = useMemo(() => (tree ? analyzeDisk(tree.files) : null), [tree]);
  if (!device) return <p className="fl-empty">Open a router to see its storage.</p>;

  const toggle = (paths: string[], on: boolean): void => {
    const next = new Set(picked);
    for (const path of paths)
      if (on) next.add(path);
      else next.delete(path);
    setPicked(next);
  };
  const pickedBytes = (tree?.files ?? [])
    .filter((file) => picked.has(file.path))
    .reduce((sum, file) => sum + file.size, 0);
  const remove = (): void => {
    filesApi
      .remove(device, Array.from(picked))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        filesBus.changed(device, "/");
        setRound((n) => n + 1);
      });
  };
  const used = usage?.total && usage.free !== undefined ? usage.total - usage.free : null;
  const pct = used !== null && usage?.total ? Math.round((used / usage.total) * 100) : null;
  const blocks = report
    ? [
        ...report.groups.slice(0, 4),
        ...(report.groups.length > 4
          ? [
              {
                name: "other",
                bytes: report.groups.slice(4).reduce((sum, g) => sum + g.bytes, 0),
                count: report.groups.slice(4).reduce((sum, g) => sum + g.count, 0),
              },
            ]
          : []),
      ]
    : [];
  const fileRow = (file: TreeFile): ReactNode => (
    <div key={file.path} className="fl-lr fl-st-file">
      {!readOnly ? (
        <Checkbox
          checked={picked.has(file.path)}
          onCheckedChange={(on) => toggle([file.path], on)}
          aria-label={`Select ${file.path}`}
        />
      ) : (
        <span />
      )}
      <span className="n" title={file.path}>
        {file.path}
      </span>
      <span className="m">{stamp(file.mtime)}</span>
      <span className="m">{size(file.size)}</span>
    </div>
  );
  const groups = [
    ...(report?.suggestions ?? []).map((item) => ({
      ...suggestion(item.title, item.files.length),
      key: item.title,
      files: item.files,
    })),
    ...(report && report.largest.length > 0
      ? [
          {
            key: "largest",
            name: "Largest files",
            why: `The ${report.largest.length} biggest files on ${device}.`,
            icon: <ChartPie size={15} />,
            files: report.largest,
          },
        ]
      : []),
  ];

  return (
    <div className="fl-tool">
      <div className="fl-tool-hd">
        <ChartPie size={16} aria-hidden="true" />
        <h3>Storage on {device}</h3>
        <span className="m">
          {used !== null && usage?.total ? `${size(used)} used of ${size(usage.total)}` : ""}
          {used !== null && tree ? " · " : ""}
          {tree && `${tree.files.length.toLocaleString("en-US")} files`}
          {tree?.truncated && " · only a part was read"}
        </span>
        <span className="sp" />
        {pct !== null && (
          <span className="fl-badge" data-tone={pct > 85 ? "warn" : undefined}>
            {pct}% used
          </span>
        )}
      </div>
      {error && <Strip tone="danger">{error}</Strip>}
      {!report && !error && <p className="fl-empty">Reading every folder of {device}…</p>}
      {report && (
        <div className="fl-tm" role="img" aria-label="Space for each top folder">
          {blocks.map((group, index) => (
            <div
              key={group.name}
              data-tone={BLOCK[index % BLOCK.length]}
              style={{ flex: Math.max(group.bytes, report.total / 40) }}
              {...tipProps({
                title: group.name,
                sub: device,
                rows: [
                  { label: "Size", value: size(group.bytes) },
                  { label: "Files", value: group.count.toLocaleString("en-US") },
                  {
                    label: "Share",
                    value: `${report.total ? Math.round((group.bytes / report.total) * 100) : 0}%`,
                  },
                ],
              })}
            >
              <b>{size(group.bytes)}</b>
              <span>{group.name}</span>
            </div>
          ))}
        </div>
      )}
      {groups.map((item) => {
        const total = item.files.reduce((sum, file) => sum + file.size, 0);
        const all = item.files.every((file) => picked.has(file.path));
        const expanded = openGroup === item.key;
        return (
          <div key={item.key} className="fl-sug-wrap">
            <div className="fl-sug">
              <span className="ic" aria-hidden="true">
                {item.icon}
              </span>
              <button
                type="button"
                className="txt"
                aria-expanded={expanded}
                onClick={() => setOpenGroup(expanded ? null : item.key)}
              >
                <b>
                  {item.name}
                  <ChevronDown size={13} data-open={expanded || undefined} aria-hidden="true" />
                </b>
                <span>{item.why}</span>
              </button>
              <span className="sz">{size(total)}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="fp-act"
                  onClick={() =>
                    toggle(
                      item.files.map((file) => file.path),
                      !all,
                    )
                  }
                >
                  {all ? "Unselect all" : "Select all"}
                </button>
              )}
            </div>
            {expanded && <div className="fl-st-files">{item.files.map(fileRow)}</div>}
          </div>
        );
      })}
      {picked.size > 0 && (
        <Strip
          tone="danger"
          role="alertdialog"
          label="Delete files"
          icon={<Trash2 size={15} />}
          actions={
            <>
              <button type="button" className="fp-act" onClick={() => setPicked(new Set())}>
                Cancel
              </button>
              <button type="button" className="fp-act" data-tone="danger" onClick={remove}>
                Delete from {device}
              </button>
            </>
          }
        >
          <b>
            {picked.size} selected · {size(pickedBytes)}
          </b>
        </Strip>
      )}
    </div>
  );
}
