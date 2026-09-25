/**
 * Unit test for Safe Mode activation detection — RouterOS confirms entry either
 * by redrawing the prompt with `<SAFE>` or by printing a textual confirmation,
 * and both must count as activated.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { EventEmitter } from "node:events";
import {
  SafeModeManager,
  classifyPrompt,
  isSafeModeActivated,
  isSafeModeReleased,
} from "../../src/ssh/safe-mode";

describe("isSafeModeActivated", () => {
  test("accepts the <SAFE> prompt marker", () => {
    expect(isSafeModeActivated("[admin@MikroTik] <SAFE> > ")).toBe(true);
  });
  test("accepts a textual confirmation (dumb terminal / some v7 builds)", () => {
    expect(isSafeModeActivated("\r\nTaking Safe Mode session... Success!\r\n")).toBe(true);
    expect(isSafeModeActivated("[Safe Mode taken]")).toBe(true);
  });
  test("rejects output with no activation signal", () => {
    expect(isSafeModeActivated("[admin@MikroTik] > ")).toBe(false);
    expect(isSafeModeActivated("")).toBe(false);
  });
});

describe("isSafeModeReleased", () => {
  test("true when the last prompt is normal (safe mode exited)", () => {
    expect(isSafeModeReleased("[admin@MikroTik] > ")).toBe(true);
    expect(isSafeModeReleased("\r\n[admin@MikroTik] > ")).toBe(true);
  });
  test("false while still on the <SAFE> prompt — must not tear down yet", () => {
    expect(isSafeModeReleased("[admin@MikroTik] <SAFE> > ")).toBe(false);
  });
  test("false on a lingering <SAFE> redraw even if a normal prompt appeared earlier", () => {
    // The buffer settles on <SAFE> last → not released; waiting must continue.
    expect(isSafeModeReleased("[admin@MikroTik] > \r\n[admin@MikroTik] <SAFE> > ")).toBe(false);
  });
  test("true once the normal prompt is the final line after the <SAFE> one", () => {
    expect(isSafeModeReleased("[admin@MikroTik] <SAFE> > \r\n[admin@MikroTik] > ")).toBe(true);
  });
  test("false on empty / no prompt", () => {
    expect(isSafeModeReleased("")).toBe(false);
  });
});

describe("classifyPrompt — commit-side mode detection", () => {
  test("accepts actual RouterOS 7 Safe Mode prompts without an extra >", () => {
    expect(classifyPrompt("[admin@Ali's-Mikrotik-Home-AX3] <SAFE> ")).toBe("safe");
    expect(classifyPrompt("[admin@CHR] /ipv6/address<SAFE> ")).toBe("safe");
    expect(classifyPrompt("[admin@CHR] /ipv6/address> ")).toBe("released");
    expect(classifyPrompt("[admin@CHR] <SAFE> /system identity print")).toBe("unknown");
  });
  test("'released' on a settled normal prompt", () => {
    expect(classifyPrompt("[admin@MikroTik] > ")).toBe("released");
    expect(classifyPrompt("\r\n[Safe mode released]\r\n[admin@MikroTik] > ")).toBe("released");
  });
  test("'safe' while the prompt still shows <SAFE> (commit not taken → retry, don't loop)", () => {
    expect(classifyPrompt("[admin@MikroTik] <SAFE> > ")).toBe("safe");
    // A transient normal line followed by a settled <SAFE> prompt is still 'safe'.
    expect(classifyPrompt("[admin@MikroTik] > \r\n[admin@MikroTik] <SAFE> > ")).toBe("safe");
  });
  test("'unknown' when no prompt was captured (timed out / wedged — never claim success)", () => {
    expect(classifyPrompt("")).toBe("unknown");
    expect(classifyPrompt("...some banner with no prompt...")).toBe("unknown");
  });
  test("settles on the LAST prompt after a Ctrl+X then Enter nudge", () => {
    // Ctrl+X redraws <SAFE>, Enter then renders the real post-commit prompt.
    expect(classifyPrompt("[admin@MikroTik] <SAFE> > \r\n[admin@MikroTik] > ")).toBe("released");
    expect(classifyPrompt("[admin@MikroTik] <SAFE> \r[admin@MikroTik] > ")).toBe("released");
  });
});

describe("Safe Mode interactive round trips", () => {
  function session(onWrite: (input: string, emit: (text: string) => void) => void) {
    const channel = Object.assign(new EventEmitter(), {
      write(input: string) {
        onWrite(input, (text) => channel.emit("data", Buffer.from(text)));
      },
      end() {},
    });
    const manager = new SafeModeManager("test-device");
    Object.assign(manager, { active: true, channel });
    return { manager, channel };
  }

  test("completes read-only commands with the real CR-redrawn Safe Mode prompt", async () => {
    const { manager, channel } = session((input, emit) => {
      expect(input).toBe("/system identity print\n");
      emit(
        "/system identity print\r[admin@Ali's-Mikrotik-Home-AX3] <SAFE> /system identity print\r\n",
      );
      emit(
        "\r  name: Ali's-Mikrotik-Home-AX3\r\r\n\r\r[admin@Ali's-Mikrotik-Home-AX3] <SAFE>                                         \r[admin@Ali's-Mikrotik-Home-AX3] <SAFE> ",
      );
    });
    expect(await manager.execute("/system identity print")).toBe("name: Ali's-Mikrotik-Home-AX3");
    expect(channel.listenerCount("data")).toBe(0);
    await manager.rollback();
  });

  test("commits only after a real sentinel output and released prompt", async () => {
    let safe = true;
    let toggles = 0;
    const { manager } = session((input, emit) => {
      if (input === "\x18") {
        safe = false;
        toggles++;
        return;
      }
      const prompt = `[admin@CHR] ${safe ? "<SAFE>" : ">"} `;
      emit(`${prompt}${input}\r\n`);
      emit(`${JSON.parse(input.trim().slice(5))}\r\n${prompt}`);
    });
    expect((await manager.commit()).ok).toBe(true);
    expect(toggles).toBe(1);
    expect(manager.isActive).toBe(false);
  });

  test("preserves neighbor rows after a horizontally scrolled command echo", async () => {
    const command = '/ipv6 neighbor print where mac-address~"4E:76:31:54:43:62"';
    const { manager } = session((_input, emit) => {
      // RouterOS 7.24.2, dumb terminal: '<' replaces the clipped beginning.
      emit('/ipv6 neighbor print where mac-address~"\r');
      emit("[admin@Home] <SAFE> /ipv6 neighbor print where mac-address~>\r");
      emit('<ipv6 neighbor print where mac-address~"4                      \r');
      emit(`<${command.slice(1)}\r<${command.slice(1)}\r\n`);
      emit("Flags: D - DYNAMIC\r\n0 D fd79::2 4E:76:31:54:43:62 bridge\r\n");
      emit("[admin@Home] <SAFE> ");
    });
    try {
      expect(await manager.execute(command)).toBe(
        "Flags: D - DYNAMIC\n0 D fd79::2 4E:76:31:54:43:62 bridge",
      );
    } finally {
      await manager.rollback();
    }
  });

  test("preserves a device error after a scrolled echo", async () => {
    const command = '/ip firewall filter add comment="a long command"';
    const { manager } = session((_input, emit) => {
      emit(`<${command.slice(10)}\r\n`);
      emit("failure: configuration flagged\r\n[admin@Home] <SAFE> ");
    });
    try {
      expect(await manager.execute(command)).toBe("failure: configuration flagged");
    } finally {
      await manager.rollback();
    }
  });

  test("commit cannot classify a timeout prompt without sentinel output as success", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const { manager } = session((input, emit) => {
      writes.push(input);
      emit(`${input}\r\n[admin@Home] > `); // echo only, no sentinel output
    });
    try {
      const result = manager.commit();
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await result).ok).toBe(false);
      expect(manager.isActive).toBe(true);
      expect(writes).not.toContain("\x18");
    } finally {
      await manager.rollback();
      vi.useRealTimers();
    }
  });

  test("commit requires a fresh sentinel after toggling, not a replayed probe", async () => {
    vi.useFakeTimers();
    let previous = "";
    let toggled = false;
    const { manager } = session((input, emit) => {
      if (input === "\x18") {
        toggled = true;
        return;
      }
      if (!toggled) previous = JSON.parse(input.trim().slice(5));
      emit(`${input}\r\n${previous}\r\n[admin@Home] ${toggled ? ">" : "<SAFE>"} `);
    });
    try {
      const result = manager.commit();
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await result).ok).toBe(false);
      expect(manager.isActive).toBe(true);
    } finally {
      await manager.rollback();
      vi.useRealTimers();
    }
  });

  test("does not mistake an earlier prompt for command completion", async () => {
    const { manager } = session((_input, emit) => {
      emit("[admin@CHR] <SAFE> \r\n/system identity print\r\n");
      queueMicrotask(() => emit("name: CHR\r\n[admin@CHR] <SAFE> "));
    });
    expect(await manager.execute("/system identity print")).toContain("name: CHR");
    await manager.rollback();
  });

  test("drains the split sniffer settings pager before accepting the next command", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const { manager, channel } = session((input, emit) => {
      writes.push(input);
      if (input === "/tool sniffer print\n") {
        emit(`${input}\r\nonly-headers: yes\r\nfilter-port: 443\r\n`);
        emit("\x1B[7m-- [Q quit|D du");
        emit("mp|down]\x1B[0m\r");
      } else if (input === " ") {
        // Synchronous chunks exercise re-entrant channel.write callbacks too.
        emit("\r\x1B[Kfilter-direction: any\r\nrunning: no\r\n");
        emit("[admin@CHR] <SAFE> ");
      } else {
        emit(`${input}\r\n[admin@CHR] <SAFE> `);
      }
    });
    try {
      const output = manager.execute("/tool sniffer print").catch(String);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await output).toBe(
        "only-headers: yes\nfilter-port: 443\n\nfilter-direction: any\nrunning: no",
      );
      expect(writes).toEqual(["/tool sniffer print\n", " "]);
      expect(await manager.execute("/tool sniffer start")).toBe("");
      expect(writes.at(-1)).toBe("/tool sniffer start\n");
      expect(channel.listenerCount("data")).toBe(0);
    } finally {
      await manager.rollback();
      vi.useRealTimers();
    }
  });

  test("an ambiguous timeout fences queued commands and commit until rollback", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const { manager, channel } = session((input, emit) => {
      writes.push(input);
      emit(`${input}\r\npartial output, no prompt`);
    });
    try {
      const first = manager.execute("/tool sniffer start").catch(String);
      const queued = manager.execute("/tool sniffer stop").catch(String);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await first).toMatch(/Execution may have occurred/);
      expect(await queued).toMatch(/uncertain|unverified/i);
      expect(writes).toEqual(["/tool sniffer start\n"]);
      expect(manager.isActive).toBe(true); // must not fall back to one-shot SSH
      expect(manager.status()).toMatch(/uncertain|unverified/i);
      const committed = manager.commit();
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await committed).ok).toBe(false);
      expect(writes).toEqual(["/tool sniffer start\n"]);
      expect(channel.listenerCount("data")).toBe(0);
    } finally {
      await manager.rollback();
      vi.useRealTimers();
    }
  });

  test("advances multiple pages without dumping a file or losing rows", async () => {
    const writes: string[] = [];
    let page = 0;
    const { manager } = session((input, emit) => {
      writes.push(input);
      if (page === 0) emit(input);
      emit(`\r\nrule-${++page}\r\n`);
      if (page < 3) emit("-- [Q quit|D dump|right|up|down]\r");
      else emit("[admin@CHR] <SAFE> ");
    });
    try {
      const out = await manager.execute("/ip firewall mangle print");
      expect(out).toContain("rule-1");
      expect(out).toContain("rule-2");
      expect(out).toContain("rule-3");
      expect(out).not.toContain("Q quit");
      expect(writes).toEqual(["/ip firewall mangle print\n", " ", " "]);
    } finally {
      await manager.rollback();
    }
  });

  test.each([
    "-- [Q quit|D dump|C-z pause]",
    "Do you want to continue? [y/N]",
    'comment="-- [Q quit|D dump|down]"',
  ])("never answers a monitor, confirmation, or quoted pager: %s", async (footer) => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const { manager } = session((input, emit) => {
      writes.push(input);
      emit(`${input}\r\n${footer}\r`);
    });
    try {
      const out = manager.execute("/test").catch(String);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await out).toMatch(/timeout/);
      expect(writes).toEqual(["/test\n"]);
    } finally {
      await manager.rollback();
      vi.useRealTimers();
    }
  });

  test("pages cannot extend the absolute execution deadline forever", async () => {
    vi.useFakeTimers();
    const pending: ReturnType<typeof setTimeout>[] = [];
    const { manager, channel } = session((input, emit) => {
      if (input !== " ") emit(input);
      pending.push(setTimeout(() => emit("\r\nrow\r\n-- [Q quit|D dump|down]\r"), 1_000));
    });
    try {
      const out = manager.execute("/test print").catch(String);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await out).toMatch(/timeout/);
      expect(channel.listenerCount("data")).toBe(0);
    } finally {
      for (const timer of pending) clearTimeout(timer);
      await manager.rollback();
      vi.useRealTimers();
    }
  });
});

describe("unexpected session drop — no false success", () => {
  /**
   * Simulate the reported bug: the persistent shell drops WHILE Safe Mode is
   * active (changes staged, not committed), so RouterOS has auto-reverted them.
   * The manager must never then report a commit as succeeding.
   */
  function droppedManager(): SafeModeManager {
    const mgr = new SafeModeManager("test-device");
    // Mid-session state, then fire the shell's close listener.
    (mgr as unknown as { active: boolean }).active = true;
    (mgr as unknown as { handleUnexpectedDrop: () => void }).handleUnexpectedDrop();
    return mgr;
  }

  test("a drop clears active and records the revert", () => {
    const mgr = droppedManager();
    expect(mgr.isActive).toBe(false);
    expect(mgr.status()).toMatch(/DROPPED/i);
    expect(mgr.status()).toMatch(/NOT saved/i);
  });

  test("commit after a drop reports failure, not 'nothing to commit'", async () => {
    const result = await droppedManager().commit();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/reverted/i);
    expect(result.message).not.toMatch(/nothing to commit/i);
  });

  test("rollback after a drop explains the changes were already reverted", async () => {
    const msg = await droppedManager().rollback();
    expect(msg).toMatch(/auto-reverted/i);
  });

  test("a close while inactive (clean teardown) is a no-op", () => {
    const mgr = new SafeModeManager("test-device");
    (mgr as unknown as { handleUnexpectedDrop: () => void }).handleUnexpectedDrop();
    expect(mgr.status()).toMatch(/NOT active/i);
  });
});
