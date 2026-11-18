/** Dashboard Files: paths, listings, search, transfers and the route guards — on a fake SFTP. */
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

/** An in-memory router disk: a path maps to its bytes, or to "dir". */
function fakeSftp(tree: Record<string, string | "dir">, options: { failWrites?: boolean } = {}) {
  const disk = new Map<string, Buffer | "dir">(
    Object.entries(tree).map(([path, body]) => [path, body === "dir" ? "dir" : Buffer.from(body)]),
  );
  const attrs = (body: Buffer | "dir") => ({
    size: body === "dir" ? 0 : body.length,
    mtime: 1_700_000_000,
    isDirectory: () => body === "dir",
  });
  const missing = (): Error => new Error("No such file");
  const sftp = Object.assign(new EventEmitter(), {
    readdir(dir: string, done: (err: Error | undefined, list?: unknown[]) => void) {
      if (dir !== "/" && disk.get(dir) !== "dir") return done(missing());
      const prefix = dir === "/" ? "/" : `${dir}/`;
      done(
        undefined,
        Array.from(disk)
          .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
          .map(([path, body]) => ({ filename: path.slice(prefix.length), attrs: attrs(body) })),
      );
    },
    stat(path: string, done: (err: Error | undefined, stats?: unknown) => void) {
      const body = disk.get(path);
      return body === undefined ? done(missing()) : done(undefined, attrs(body));
    },
    unlink(path: string, done: (err?: Error) => void) {
      done(disk.delete(path) ? undefined : missing());
    },
    rmdir(path: string, done: (err?: Error) => void) {
      done(disk.delete(path) ? undefined : missing());
    },
    mkdir(path: string, done: (err?: Error) => void) {
      disk.set(path, "dir");
      done();
    },
    rename(from: string, to: string, done: (err?: Error) => void) {
      const body = disk.get(from);
      if (body === undefined) return done(missing());
      disk.delete(from);
      disk.set(to, body);
      done();
    },
    readFile(path: string, done: (err: Error | undefined, body?: Buffer) => void) {
      const body = disk.get(path);
      return Buffer.isBuffer(body) ? done(undefined, body) : done(missing());
    },
    createReadStream(path: string, range?: { start?: number; end?: number }) {
      const body = (disk.get(path) as Buffer).subarray(
        range?.start ?? 0,
        range?.end === undefined ? undefined : range.end + 1,
      );
      return Readable.from([body.subarray(0, 3), body.subarray(3)]);
    },
    createWriteStream(path: string, range?: { start?: number }) {
      // With a start, the bytes before it stay (a resumed copy).
      const kept = range?.start
        ? (disk.get(path) as Buffer).subarray(0, range.start)
        : Buffer.alloc(0);
      const parts: Buffer[] = [kept];
      if (!range?.start) disk.set(path, Buffer.alloc(0)); // SFTP creates the file when it opens it
      return new Writable({
        write(chunk: Buffer, _encoding, next) {
          if (options.failWrites) return next(new Error("disk full"));
          parts.push(Buffer.from(chunk));
          next();
        },
        final(next) {
          disk.set(path, Buffer.concat(parts));
          next();
        },
      });
    },
  });
  return { sftp, disk };
}

const routers: Record<string, ReturnType<typeof fakeSftp>> = {};
const endpoints: Record<string, Record<string, unknown>> = {};
const config = { readOnly: false };
const audit = vi.fn();

vi.mock("../../src/ssh/client", () => ({
  MikroTikSSHClient: class {
    lastError = undefined;
    constructor(private readonly options: { name: string }) {}
    connect = async () => true;
    sftp = async () => routers[this.options.name]!.sftp;
    disconnect = () => {};
  },
}));
vi.mock("../../src/core/runtime", () => ({
  getConfig: () => config,
  getDevice: (name: string) => {
    if (!routers[name]) throw new Error(`Unknown device '${name}'`);
    return { name, ...endpoints[name] };
  },
  resolveDeviceName: (name: string) => name,
}));
vi.mock("../../src/core/transport", () => ({
  isMacTelnetDevice: () => false,
  resolveJump: () => undefined,
  sshOptionsOf: (dc: { name: string }) => ({ name: dc.name }),
}));
const commands: string[] = [];
vi.mock("../../src/core/connector", () => ({
  executeMikrotikCommand: async (command: string) => {
    commands.push(command);
    // A fake `/tool fetch`: the destination pulls the file from the source.
    const fetch = command.match(/^\/tool fetch .*src-path=(\S+) dst-path=(\S+)/);
    if (fetch && !command.includes("unreachable"))
      routers.beta!.disk.set(`/${fetch[2]}`, routers.alpha!.disk.get(`/${fetch[1]}`) as Buffer);
    if (command.includes("unreachable")) return "failure: connection timeout";
    if (command.includes("bad.rsc")) return "Script Error: found 1 error(s) in import file";
    return command.includes("dry-run") ? "No syntax errors found in the import file" : "";
  },
}));
vi.mock("../../src/core/context", () => ({ createContext: () => ({}) }));
vi.mock("../../src/observability/recorder", () => ({ recordToolCall: audit }));
vi.mock("../../src/observability/terminal-routes", () => ({
  terminalAccess: (cfg: { host: string; token?: string }) =>
    cfg.token || cfg.host === "127.0.0.1" ? null : "needs protection",
}));

const files = await import("../../src/observability/files-routes");
const routes = files.createFilesRoutes({ denied: null });
const call = (method: string, path: string, body?: unknown, raw?: string) =>
  routes(
    new Request(`http://dash.test${path}`, {
      method,
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }),
    new URL(`http://dash.test${path}`),
  ) as Promise<Response>;
const lines = async (res: Response) =>
  (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

beforeEach(() => {
  files.closeFileSessions();
  config.readOnly = false;
  audit.mockClear();
  for (const name of Object.keys(endpoints)) delete endpoints[name];
  routers.alpha = fakeSftp({
    "/flash": "dir",
    "/flash/config.rsc": "/ip address\nadd address=10.0.0.1/24\n",
    "/backup.backup": "BINARY",
    "/notes.txt": "wan is ether1\n",
  });
  routers.beta = fakeSftp({ "/old.rsc": "x" });
});

describe("paths", () => {
  test("are made absolute and normal", () => {
    expect(files.cleanPath("flash//a.rsc")).toBe("/flash/a.rsc");
    expect(files.cleanPath("/./")).toBe("/");
    expect(files.joinPath("/", "a")).toBe("/a");
  });
  test("reject '..' and control characters", () => {
    expect(() => files.cleanPath("/flash/../x")).toThrow("..");
    expect(() => files.cleanPath("/a\nb")).toThrow("not valid");
    expect(() => files.cleanPath(undefined)).toThrow("required");
  });
});

test("the page needs a protected dashboard, and can be turned off", () => {
  expect(files.filesAccess({ host: "127.0.0.1" })).toBeNull();
  expect(files.filesAccess({ host: "0.0.0.0", token: "t" })).toBeNull();
  expect(files.filesAccess({ host: "0.0.0.0" })).toContain("protected dashboard");
  expect(files.filesAccess({ host: "127.0.0.1", files: false })).toContain("turned off");
});

test("a listing puts folders first, then names in order", async () => {
  const res = await call("GET", "/api/files/list?device=alpha&path=/");
  const { entries } = (await res.json()) as { entries: { name: string; dir: boolean }[] };
  expect(entries.map((entry) => entry.name)).toEqual(["flash", "backup.backup", "notes.txt"]);
  expect(entries[0]?.dir).toBe(true);
});

test("an unknown router and a bad path are refused", async () => {
  expect((await call("GET", "/api/files/list?device=nope&path=/")).status).toBe(404);
  expect((await call("GET", "/api/files/list?device=alpha&path=/../etc")).status).toBe(400);
});

describe("search", () => {
  test("finds names on several routers at once", async () => {
    const res = await call("POST", "/api/files/search", {
      q: ".rsc",
      targets: [
        { device: "alpha", path: "/" },
        { device: "beta", path: "/" },
      ],
    });
    const items = await lines(res);
    const hits = items.filter((item) => item.t === "hit").map((hit) => `${hit.device}:${hit.path}`);
    expect(hits.sort()).toEqual(["alpha:/flash/config.rsc", "beta:/old.rsc"]);
    expect(items.filter((item) => item.t === "done")).toHaveLength(2);
  });
  test("finds a line inside a text file, and skips binary files", async () => {
    const res = await call("POST", "/api/files/search", {
      q: "address=\\d+",
      regex: true,
      contents: true,
      targets: [{ device: "alpha", path: "/" }],
    });
    const hits = (await lines(res)).filter((item) => item.t === "hit");
    expect(hits).toEqual([
      expect.objectContaining({
        path: "/flash/config.rsc",
        line: 2,
        text: "add address=10.0.0.1/24",
      }),
    ]);
  });
  test("refuses a bad regular expression", async () => {
    const res = await call("POST", "/api/files/search", {
      q: "(",
      regex: true,
      targets: [{ device: "alpha", path: "/" }],
    });
    expect(res.status).toBe(400);
  });
});

test("a download streams the whole file with its size", async () => {
  const res = await call("GET", "/api/files/download?device=alpha&path=/notes.txt");
  expect(res.headers.get("content-length")).toBe("14");
  expect(res.headers.get("content-disposition")).toContain("notes.txt");
  expect(await res.text()).toBe("wan is ether1\n");
  expect((await call("GET", "/api/files/download?device=alpha&path=/flash")).status).toBe(400);
});

test("a text file is read whole; a folder and a binary file are refused", async () => {
  const res = await call("GET", "/api/files/read?device=alpha&path=/notes.txt");
  expect(await res.json()).toEqual({ text: "wan is ether1\n", size: 14, mtime: 1_700_000_000 });
  expect((await call("GET", "/api/files/read?device=alpha&path=/flash")).status).toBe(400);
  routers.alpha!.disk.set("/blob.bin", Buffer.from([1, 0, 2]));
  expect((await call("GET", "/api/files/read?device=alpha&path=/blob.bin")).status).toBe(415);
});

describe("changes", () => {
  test("an upload writes the body to the router and is audited", async () => {
    const res = await call(
      "POST",
      "/api/files/upload?device=beta&path=/new.rsc",
      undefined,
      "hello",
    );
    expect(await res.json()).toEqual({ ok: true, bytes: 5 });
    expect(routers.beta!.disk.get("/new.rsc")?.toString()).toBe("hello");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "dashboard_files",
        device: "beta",
        risk: "WRITE",
        isError: false,
      }),
    );
  });
  test("a write that the router never answers ends with an error, not a wait", async () => {
    vi.useFakeTimers();
    try {
      const { sftp, disk } = fakeSftp({});
      // A router that takes the bytes and never confirms them: a lost connection.
      sftp.createWriteStream = (() => new Writable({ write() {} })) as never;
      const written = files.writeStream(
        sftp as never,
        "/x.bin",
        (async function* () {
          yield new Uint8Array(10);
        })(),
      );
      const outcome = written.catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(files.WRITE_ANSWER_MS + 11_000);
      expect(await outcome).toContain("did not answer for 60 seconds");
      expect(disk.has("/x.bin")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  test("a failed upload leaves no partial file", async () => {
    routers.beta = fakeSftp({}, { failWrites: true });
    const res = await call(
      "POST",
      "/api/files/upload?device=beta&path=/big.npk",
      undefined,
      "data",
    );
    expect(res.status).toBe(502);
    expect(routers.beta.disk.has("/big.npk")).toBe(false);
  });
  test("a copy relays a file from one router to another with progress", async () => {
    const res = await call("POST", "/api/files/transfer", {
      from: { device: "alpha", path: "/flash/config.rsc" },
      to: { device: "beta", path: "/config.rsc" },
    });
    const items = await lines(res);
    expect(items[0]).toEqual({ t: "start", total: 36, via: "relay", resumed: 0 });
    expect(items.at(-1)).toEqual(expect.objectContaining({ t: "end", ok: true, bytes: 36 }));
    expect(routers.beta!.disk.get("/config.rsc")).toEqual(
      routers.alpha!.disk.get("/flash/config.rsc"),
    );
  });
  test("a copy of a missing file reports the error and writes nothing", async () => {
    const res = await call("POST", "/api/files/transfer", {
      from: { device: "alpha", path: "/nope.rsc" },
      to: { device: "beta", path: "/nope.rsc" },
    });
    expect((await lines(res)).at(-1)).toEqual(expect.objectContaining({ t: "end", ok: false }));
    expect(routers.beta!.disk.has("/nope.rsc")).toBe(false);
  });
  test("delete, rename and new folder", async () => {
    await call("POST", "/api/files/rename", {
      device: "alpha",
      from: "/notes.txt",
      to: "/wan.txt",
    });
    await call("POST", "/api/files/mkdir", { device: "alpha", path: "/exports" });
    const res = await call("POST", "/api/files/delete", {
      device: "alpha",
      paths: ["/backup.backup", "/gone.txt"],
    });
    expect(await res.json()).toEqual({
      ok: false,
      failed: [{ path: "/gone.txt", error: "No such file" }],
    });
    expect(Array.from(routers.alpha!.disk.keys()).sort()).toEqual([
      "/exports",
      "/flash",
      "/flash/config.rsc",
      "/wan.txt",
    ]);
    expect(
      (await call("POST", "/api/files/delete", { device: "alpha", paths: ["/"] })).status,
    ).toBe(400);
  });
  test("a read-only server lists and downloads, and changes nothing", async () => {
    config.readOnly = true;
    expect((await call("GET", "/api/files/list?device=alpha&path=/")).status).toBe(200);
    for (const [path, body] of [
      ["/api/files/upload?device=alpha&path=/x", undefined],
      ["/api/files/delete", { device: "alpha", paths: ["/notes.txt"] }],
      ["/api/files/transfer", {}],
    ] as const)
      expect((await call("POST", path, body, body ? undefined : "x")).status).toBe(403);
    expect(routers.alpha!.disk.has("/notes.txt")).toBe(true);
  });
  test("a cross-origin upload is refused", async () => {
    const res = (await routes(
      new Request("http://dash.test/api/files/upload?device=beta&path=/x", {
        method: "POST",
        body: "x",
        headers: { origin: "http://evil.test" },
      }),
      new URL("http://dash.test/api/files/upload?device=beta&path=/x"),
    )) as Response;
    expect(res.status).toBe(403);
  });
});

describe("folders", () => {
  test("an upload makes the folders above the file", async () => {
    await call("POST", "/api/files/upload?device=beta&path=/a/b/c.txt", undefined, "x");
    expect(Array.from(routers.beta!.disk.keys()).sort()).toEqual([
      "/a",
      "/a/b",
      "/a/b/c.txt",
      "/old.rsc",
    ]);
  });
  test("a tree lists every file below a folder", async () => {
    const res = await call("GET", "/api/files/tree?device=alpha&path=/flash");
    expect(await res.json()).toEqual({
      files: [{ path: "/flash/config.rsc", size: 36, mtime: 1_700_000_000 }],
      dirs: ["/flash"],
      truncated: false,
    });
  });
  test("a folder is deleted with what is in it", async () => {
    const res = await call("POST", "/api/files/delete", { device: "alpha", paths: ["/flash"] });
    expect(await res.json()).toEqual({ ok: true, failed: [] });
    expect(Array.from(routers.alpha!.disk.keys()).sort()).toEqual(["/backup.backup", "/notes.txt"]);
  });
  test("a ZIP holds the selected files, with folders, and valid checksums", async () => {
    const res = await call("GET", "/api/files/zip?device=alpha&path=/flash&path=/notes.txt");
    const zip = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get("content-type")).toBe("application/zip");
    // End record: two entries; the central directory names both files.
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    const directory = zip.subarray(zip.readUInt32LE(end + 16), end).toString("latin1");
    expect(directory).toContain("flash/config.rsc");
    expect(directory).toContain("notes.txt");
    // The stored bytes of the second file follow its local header.
    expect(zip.toString("latin1")).toContain("wan is ether1\n");
    const { crc32 } = await import("node:zlib");
    const first = zip.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
    expect(zip.readUInt32LE(first + 4)).toBe(
      crc32(routers.alpha!.disk.get("/flash/config.rsc") as Buffer),
    );
  });
});

describe("recycle bin", () => {
  test("a deleted and a replaced file can be put back", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const trash = await import("../../src/observability/files-trash");
    trash.setTrashDir(mkdtempSync(join(tmpdir(), "files-trash-")));
    try {
      await call("POST", "/api/files/delete", { device: "alpha", paths: ["/notes.txt"] });
      await call("POST", "/api/files/upload?device=beta&path=/old.rsc", undefined, "new text");
      const listed = (await (await call("GET", "/api/files/trash")).json()) as {
        items: { id: string; path: string; reason: string; device: string }[];
      };
      expect(listed.items.map((item) => [item.device, item.path, item.reason]).sort()).toEqual([
        ["alpha", "/notes.txt", "deleted"],
        ["beta", "/old.rsc", "replaced"],
      ]);
      const deleted = listed.items.find((item) => item.reason === "deleted")!;
      const res = await call("POST", "/api/files/trash/restore", { id: deleted.id });
      expect(await res.json()).toEqual({ ok: true, device: "alpha", path: "/notes.txt" });
      expect(routers.alpha!.disk.get("/notes.txt")?.toString()).toBe("wan is ether1\n");
      expect((await call("POST", "/api/files/trash/restore", { id: "../x" })).status).toBe(404);
      expect(await (await call("POST", "/api/files/trash/purge", {})).json()).toEqual({
        removed: 1,
      });
    } finally {
      trash.setTrashDir(undefined);
    }
  });
  test("items older than a week are removed", async () => {
    const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const trash = await import("../../src/observability/files-trash");
    const dir = mkdtempSync(join(tmpdir(), "files-trash-"));
    trash.setTrashDir(dir);
    const old = { id: "1-old", device: "alpha", path: "/a", size: 1, ts: 1, reason: "deleted" };
    writeFileSync(join(dir, "1-old.json"), JSON.stringify(old));
    writeFileSync(join(dir, "1-old.bin"), "x");
    expect(trash.listTrash()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    trash.setTrashDir(undefined);
  });
});

test("router files are saved to the vault, and a vault file is sent to a router", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "files-vault-"));
  process.env.MIKROTIK_BACKUP_DIR = dir;
  try {
    config.readOnly = true; // saving reads the router, so a read-only server may do it
    const saved = await call("POST", "/api/files/vault/save", {
      device: "alpha",
      paths: ["/backup.backup", "/flash"],
    });
    expect(await saved.json()).toEqual({
      ok: false,
      saved: [{ path: "/backup.backup", name: "alpha_backup.backup" }],
      failed: [{ path: "/flash", error: "A folder is not saved. Select its files." }],
    });
    expect(readFileSync(join(dir, "alpha_backup.backup"), "utf8")).toBe("BINARY");
    const listed = (await (await call("GET", "/api/files/vault")).json()) as {
      files: { name: string; bytes: number }[];
    };
    expect(listed.files.map((file) => [file.name, file.bytes])).toEqual([
      ["alpha_backup.backup", 6],
    ]);
    const send = { name: "alpha_backup.backup", device: "beta", dir: "/restore" };
    expect((await call("POST", "/api/files/vault/send", send)).status).toBe(403);
    config.readOnly = false;
    expect(await (await call("POST", "/api/files/vault/send", send)).json()).toEqual({
      ok: true,
      path: "/restore/alpha_backup.backup",
    });
    expect(routers.beta!.disk.get("/restore/alpha_backup.backup")?.toString()).toBe("BINARY");
    const escape = await call("POST", "/api/files/vault/send", { ...send, name: "../x" });
    expect(escape.status).toBe(502);
  } finally {
    delete process.env.MIKROTIK_BACKUP_DIR;
  }
});

test("a tail gives the end of a file, then what is added to it", async () => {
  const res = await call("GET", "/api/files/tail?device=alpha&path=/notes.txt&every=200");
  const reader = res.body!.getReader();
  const text = async (): Promise<string> => {
    let got = "";
    // The fake stream gives a read in two parts.
    while (!got.endsWith("\n")) got += new TextDecoder().decode((await reader.read()).value);
    return got;
  };
  expect(await text()).toBe("wan is ether1\n");
  routers.alpha!.disk.set("/notes.txt", Buffer.from("wan is ether1\nlink down\n"));
  expect(await text()).toBe("link down\n");
  await reader.cancel();
});

describe("checksum and resume", () => {
  const big = "0123456789".repeat(1_000_000); // 10 MB: above the resumable size
  const copy = {
    from: { device: "alpha", path: "/big.npk" },
    to: { device: "beta", path: "/big.npk" },
  };
  const sha = async (text: string) =>
    (await import("node:crypto")).createHash("sha256").update(text).digest("hex");

  test("a copy reports the SHA-256 of what passed, and verify reads the copy back", async () => {
    const plain = await lines(
      await call("POST", "/api/files/transfer", {
        from: { device: "alpha", path: "/notes.txt" },
        to: { device: "beta", path: "/notes.txt" },
        verify: true,
      }),
    );
    expect(plain.at(-1)).toEqual({
      t: "end",
      ok: true,
      bytes: 14,
      sha256: await sha("wan is ether1\n"),
      verified: true,
    });
    const hashed = await call("GET", "/api/files/hash?device=beta&path=/notes.txt");
    expect(await hashed.json()).toEqual({ sha256: await sha("wan is ether1\n") });
  });
  test("a large copy goes through a .part file and replaces the old file at the end", async () => {
    routers.alpha!.disk.set("/big.npk", Buffer.from(big));
    routers.beta!.disk.set("/big.npk", Buffer.from("old"));
    const items = await lines(await call("POST", "/api/files/transfer", copy));
    expect(items.at(-1)).toEqual(expect.objectContaining({ ok: true, sha256: await sha(big) }));
    expect(routers.beta!.disk.get("/big.npk")?.length).toBe(big.length);
    expect(routers.beta!.disk.has("/big.npk.part")).toBe(false);
  });
  test("a large copy continues from the bytes a failed copy left", async () => {
    routers.alpha!.disk.set("/big.npk", Buffer.from(big));
    routers.beta!.disk.set("/big.npk.part", Buffer.from(big.slice(0, 4_000_000)));
    const items = await lines(await call("POST", "/api/files/transfer", { ...copy, verify: true }));
    expect(items.find((item) => item.t === "start")).toEqual(
      expect.objectContaining({ resumed: 4_000_000 }),
    );
    expect(items.at(-1)).toEqual(
      expect.objectContaining({ ok: true, verified: true, sha256: await sha(big) }),
    );
    expect(routers.beta!.disk.get("/big.npk")?.toString()).toBe(big);
  });
  test("a download continues at an offset", async () => {
    const res = await call("GET", "/api/files/download?device=alpha&path=/notes.txt&offset=7");
    expect(res.headers.get("x-file-size")).toBe("14");
    expect(await res.text()).toBe("ether1\n");
  });
});

describe("direct copy", () => {
  const copy = {
    from: { device: "alpha", path: "/notes.txt" },
    to: { device: "beta", path: "/notes.txt" },
  };
  test("the destination fetches the file itself when it can", async () => {
    endpoints.alpha = { host: "10.0.0.1", port: 22, username: "admin", password: "s3cret" };
    endpoints.beta = { host: "10.0.0.2" };
    commands.length = 0;
    const items = await lines(await call("POST", "/api/files/transfer", { ...copy, direct: true }));
    expect(items[0]).toEqual({ t: "start", total: 14, via: "direct" });
    expect(items.at(-1)).toEqual({ t: "end", ok: true, bytes: 14 });
    expect(commands).toEqual([
      "/tool fetch mode=sftp address=10.0.0.1 port=22 user=admin password=s3cret src-path=notes.txt dst-path=notes.txt",
    ]);
    // The password reaches the router, and nothing else.
    expect(JSON.stringify(audit.mock.calls)).not.toContain("s3cret");
    expect(JSON.stringify(items)).not.toContain("s3cret");
  });
  test("a key-only source, and a failed fetch, are relayed instead", async () => {
    endpoints.alpha = { host: "10.0.0.1", username: "admin" };
    endpoints.beta = { host: "10.0.0.2" };
    const keyOnly = await lines(
      await call("POST", "/api/files/transfer", { ...copy, direct: true }),
    );
    expect(keyOnly[0]).toEqual(expect.objectContaining({ t: "note" }));
    expect(keyOnly.find((item) => item.t === "start")).toEqual(
      expect.objectContaining({ via: "relay" }),
    );
    endpoints.alpha = { host: "unreachable", username: "admin", password: "p" };
    const failed = await lines(
      await call("POST", "/api/files/transfer", { ...copy, direct: true }),
    );
    expect(failed.filter((item) => item.t === "start").map((item) => item.via)).toEqual([
      "direct",
      "relay",
    ]);
    expect(failed.at(-1)).toEqual(expect.objectContaining({ ok: true, bytes: 14 }));
    expect(routers.beta!.disk.get("/notes.txt")?.toString()).toBe("wan is ether1\n");
  });
  test("it is used only when asked", async () => {
    endpoints.alpha = { host: "10.0.0.1", username: "admin", password: "p" };
    endpoints.beta = { host: "10.0.0.2" };
    commands.length = 0;
    await lines(await call("POST", "/api/files/transfer", copy));
    expect(commands).toEqual([]);
  });
});

describe("router-made files and import", () => {
  test("a backup and an export are made by the router, with a safe name", async () => {
    commands.length = 0;
    const made = await call("POST", "/api/files/make", {
      device: "alpha",
      kind: "backup",
      name: "nightly",
    });
    expect(await made.json()).toEqual({ ok: true, file: "nightly.backup" });
    await call("POST", "/api/files/make", { device: "alpha", kind: "export", name: "cfg" });
    expect(commands).toEqual(["/system backup save name=nightly", "/export file=cfg"]);
    const bad = await call("POST", "/api/files/make", {
      device: "alpha",
      kind: "backup",
      name: "a b;c",
    });
    expect(bad.status).toBe(400);
  });
  test("an import is a dry run unless the caller says otherwise", async () => {
    commands.length = 0;
    const dry = await call("POST", "/api/files/import", {
      device: "alpha",
      path: "/flash/config.rsc",
    });
    expect(await dry.json()).toEqual(expect.objectContaining({ ok: true, dryRun: true }));
    await call("POST", "/api/files/import", {
      device: "alpha",
      path: "/flash/config.rsc",
      dryRun: false,
    });
    expect(commands).toEqual([
      "/import file-name=flash/config.rsc verbose=yes dry-run",
      "/import file-name=flash/config.rsc verbose=yes",
    ]);
    const failed = await call("POST", "/api/files/import", { device: "alpha", path: "/bad.rsc" });
    expect(await failed.json()).toEqual(expect.objectContaining({ ok: false, dryRun: true }));
    expect(
      (await call("POST", "/api/files/import", { device: "alpha", path: "/x.backup" })).status,
    ).toBe(400);
  });
});

test("a locked page answers only its state", async () => {
  const locked = files.createFilesRoutes({ denied: "locked" });
  const state = (await locked(
    new Request("http://dash.test/api/files/state"),
    new URL("http://dash.test/api/files/state"),
  )) as Response;
  expect(await state.json()).toEqual({
    enabled: false,
    reason: "locked",
    readOnly: false,
    trash: false,
    s3: false,
  });
  const list = (await locked(
    new Request("http://dash.test/api/files/list?device=alpha"),
    new URL("http://dash.test/api/files/list?device=alpha"),
  )) as Response;
  expect(list.status).toBe(403);
});
