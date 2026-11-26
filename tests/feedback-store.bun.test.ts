/// <reference types="bun" />
import { expect, test } from "bun:test";
import { MikrotikConfigSchema } from "../src/config";
import { setConfig } from "../src/core/runtime";
import { FEEDBACK_MEMORY_ENTITY, syncFeedbackToMemory } from "../src/feedback/memory-sync";
import { openFeedbackStore } from "../src/feedback/store";
import { closeMemoryStore, installMemoryStore } from "../src/memory/accessor";
import { openMemoryStore } from "../src/memory/store";

test("feedback store deduplicates exact and fuzzy reports, increments occurrences, and reopens resolved regressions", async () => {
  const store = await openFeedbackStore(":memory:");
  try {
    // 1. First report creates issue #1
    const r1 = store.submit({
      kind: "bug",
      impact: "friction",
      operation: "mcp__mikrotik-mcp__create_wireguard_peer",
      title: "create_wireguard_peer fails on 10.0.0.2/32 when comment has quotes",
      detail: "Calling create_wireguard_peer on router home-ax3 with quoted comment failed.",
      actual_error: "syntax error (line 1 column 34) on interface wg0",
      device: "home-ax3",
      routeros_version: "7.15.3",
      tags: ["wireguard"],
      force_new: false,
    });
    expect(r1.action).toBe("created");
    expect(r1.deduplicated).toBe(false);
    expect(r1.issue.id).toBe(1);
    expect(r1.issue.occurrences).toBe(1);

    // 2. Second report from a different router/IP hits Stage 1 exact fingerprint
    const r2 = store.submit({
      kind: "bug",
      impact: "blocker",
      operation: "create_wireguard_peer",
      title: "create_wireguard_peer fails on 192.168.99.5/32 when comment has quotes",
      detail: "Failed on netherlands-v2 with quoted comment.",
      actual_error: "syntax error (line 2 column 19) on interface wg1",
      workaround: "Strip double quotes from comment before calling create_wireguard_peer.",
      device: "netherlands-v2",
      routeros_version: "7.16.1",
      tags: ["escaping"],
      force_new: false,
    });
    expect(r2.action).toBe("Incremented existing");
    expect(r2.deduplicated).toBe(true);
    expect(r2.matchStage).toBe("exact_fingerprint");
    expect(r2.issue.id).toBe(1);
    expect(r2.issue.occurrences).toBe(2);
    // Impact escalated from friction -> blocker, tags merged, workaround captured
    expect(r2.issue.impact).toBe("blocker");
    expect(r2.issue.tags.sort()).toEqual(["escaping", "wireguard"]);
    expect(r2.issue.workaround).toContain("Strip double quotes");

    // 3. Operator resolves issue #1 with a resolution note, fixedInVersion, and replacementTool
    const resolved = store.update(1, {
      status: "resolved",
      resolution_note: "Fixed quote escaping in Cmd.set in v6.17.0.",
      fixed_in_version: "v6.17.0",
      replacement_tool: "create_wireguard_peer_v2",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.fixedInVersion).toBe("v6.17.0");
    expect(resolved.replacementTool).toBe("create_wireguard_peer_v2");

    // 4. Third report with paraphrased title hits Stage 2 fuzzy similarity, reopens #1, and returns operator guidance
    const r3 = store.submit({
      kind: "bug",
      impact: "degraded",
      operation: "create_wireguard_peer",
      title: "WireGuard peer creation fails when comment contains quote characters",
      detail:
        "Attempting to create a WireGuard peer with quotes in the comment triggers a syntax error.",
      device: "branch-1",
      tags: [],
      force_new: false,
    });
    expect(r3.action).toBe("Reopened existing");
    expect(r3.deduplicated).toBe(true);
    expect(r3.matchStage).toBe("fuzzy_similarity");
    expect(r3.issue.id).toBe(1);
    expect(r3.issue.occurrences).toBe(3);
    expect(r3.issue.status).toBe("open");
    expect(r3.issue.reopenedCount).toBe(1);
    expect(r3.advice).toContain("Fixed quote escaping");
    expect(r3.advice).toContain("Strip double quotes");
    expect(r3.advice).toContain("v6.17.0");
    expect(r3.advice).toContain("create_wireguard_peer_v2");

    // 5. Distinct issue on another operation creates #2, and manual merge combines them
    const r4 = store.submit({
      kind: "missing_tool",
      impact: "degraded",
      operation: "/ip/dns/cache",
      title: "Missing dedicated tool to flush DNS cache",
      detail: "Had to fall back to run_routeros_command /ip/dns/cache/flush.",
      tags: ["dns"],
      force_new: false,
    });
    expect(r4.action).toBe("created");
    expect(r4.issue.id).toBe(2);

    const summaryBeforeMerge = store.summary();
    expect(summaryBeforeMerge.totalIssues).toBe(2);
    expect(summaryBeforeMerge.totalOccurrences).toBe(4);
    expect(summaryBeforeMerge.repeatOccurrencesSaved).toBe(2);

    const merged = store.merge(1, 2);
    expect(merged.occurrences).toBe(4);
    expect(store.get(2)).toBeNull();
    expect(store.get(1)?.occurrences).toHaveLength(4);

    // 6. Common LLM parameter aliases (summary -> detail, device_name -> device, tool -> operation, error -> actual_error)
    const r5 = store.submit({
      kind: "missing_tool",
      title: "Missing update_script and update_scheduler tools in scheduler module",
      summary: "Lacks update_script and update_scheduler in scheduler module.",
      tool: "/system/script/set",
      device_name: "home-ax3",
      error: "no dedicated tool",
      tags: ["scheduler"],
    });
    expect(r5.action).toBe("created");
    expect(r5.issue.detail).toBe("Lacks update_script and update_scheduler in scheduler module.");
    expect(r5.issue.operation).toBe("/system/script/set");
    expect(r5.issue.lastDevice).toBe("home-ax3");
    expect(r5.issue.actualError).toBe("no dedicated tool");
  } finally {
    store.close();
  }
});

test("syncFeedbackToMemory records a shared, verified lesson in MCP knowledge memory", async () => {
  setConfig(
    MikrotikConfigSchema.parse({
      devices: { home: { host: "127.0.0.1" } },
      defaultDevice: "home",
      memory: { enabled: true, dbPath: ":memory:" },
      feedback: { enabled: true, dbPath: ":memory:" },
    }),
  );
  const memStore = await openMemoryStore(":memory:");
  installMemoryStore(memStore);
  const fbStore = await openFeedbackStore(":memory:");
  try {
    const submitted = fbStore.submit({
      kind: "missing_tool",
      impact: "degraded",
      operation: "/ip/dns/cache",
      title: "Missing dedicated tool to flush DNS cache",
      detail: "Had to fall back to raw command.",
      tags: ["dns"],
      force_new: false,
    });
    const resolved = fbStore.update(submitted.issue.id, {
      status: "resolved",
      version: "v6.22.0",
      replacement_tool: "flush_dns_cache",
      resolution: "Added dedicated flush_dns_cache tool in src/tools/dns.ts.",
    });
    expect(resolved.fixedInVersion).toBe("v6.22.0");
    expect(resolved.resolutionNote).toContain("src/tools/dns.ts");
    const factId = await syncFeedbackToMemory(resolved);
    expect(factId).toBeGreaterThan(0);

    const recalled = memStore.recall({
      query: "flush_dns_cache dns cache",
      limit: 10,
      maxChars: 4000,
      includeRelated: true,
    });
    expect(recalled.applicableScopes.some((s) => s.entityName === FEEDBACK_MEMORY_ENTITY)).toBe(
      true,
    );
    expect(
      recalled.items.some(
        (item) =>
          item.id === factId &&
          item.content.includes("**`flush_dns_cache`**") &&
          item.content.includes("**`v6.22.0`**") &&
          item.content.includes("**`src/tools/dns.ts`**"),
      ),
    ).toBe(true);
  } finally {
    fbStore.close();
    closeMemoryStore();
  }
});
