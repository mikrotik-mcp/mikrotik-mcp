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
    createReadStream(path: string) {
      const body = disk.get(path) as Buffer;
      return Readable.from([body.subarray(0, 3), body.subarray(3)]);
    },
    createWriteStream(path: string) {
      const parts: Buffer[] = [];
      disk.set(path, Buffer.alloc(0)); // SFTP creates the file when it opens it
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
    return { name };
  },
  resolveDeviceName: (name: string) => name,
}));
vi.mock("../../src/core/transport", () => ({
  isMacTelnetDevice: () => false,
  resolveJump: () => undefined,
  sshOptionsOf: (dc: { name: string }) => ({ name: dc.name }),
}));
vi.mock("../../src/core/connector", () => ({ executeMikrotikCommand: async () => "100/400" }));
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
    expect(items[0]).toEqual({ t: "start", total: 36 });
    expect(items.at(-1)).toEqual({ t: "end", ok: true, bytes: 36 });
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

test("a locked page answers only its state", async () => {
  const locked = files.createFilesRoutes({ denied: "locked" });
  const state = (await locked(
    new Request("http://dash.test/api/files/state"),
    new URL("http://dash.test/api/files/state"),
  )) as Response;
  expect(await state.json()).toEqual({ enabled: false, reason: "locked", readOnly: false });
  const list = (await locked(
    new Request("http://dash.test/api/files/list?device=alpha"),
    new URL("http://dash.test/api/files/list?device=alpha"),
  )) as Response;
  expect(list.status).toBe(403);
});
