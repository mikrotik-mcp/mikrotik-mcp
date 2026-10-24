import { beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { memoryTools } from "../src/tools/memory";

const store = vi.hoisted(() => ({
  scope: vi.fn(),
  setScope: vi.fn(),
  remember: vi.fn(),
  recall: vi.fn(),
  facts: vi.fn(),
  revise: vi.fn(),
  history: vi.fn(),
  createEntities: vi.fn(),
  createRelations: vi.fn(),
  addObservations: vi.fn(),
  deleteEntities: vi.fn(),
  deleteObservations: vi.fn(),
  deleteRelations: vi.fn(),
  readGraph: vi.fn(),
  searchNodes: vi.fn(),
  openNodes: vi.fn(),
}));
vi.mock("../src/memory/accessor", () => ({
  getMemoryStore: async () => store,
  closeMemoryStore: vi.fn(),
  resetMemoryStore: vi.fn(),
}));

function call(name: string, args: Record<string, unknown> = {}) {
  const tool = memoryTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing memory tool ${name}`);
  return tool.handler(args as never, {} as never);
}

beforeEach(() => vi.clearAllMocks());

test.each([
  ["memory_get_scope", "scope", { entityName: "router-a" }, "router-a"],
  [
    "memory_set_scope",
    "setScope",
    { entityName: "router-a", scope: "device", expectedRevision: 1 },
    { entityName: "router-a", scope: "device", expectedRevision: 1 },
  ],
  [
    "memory_remember",
    "remember",
    { entityName: "router-a", content: "uplink verified" },
    { entityName: "router-a", content: "uplink verified" },
  ],
  [
    "memory_recall",
    "recall",
    { entityName: "router-a", query: "uplink" },
    { entityName: "router-a", query: "uplink" },
  ],
  ["memory_review", "facts", { entityName: "router-a" }, { entityName: "router-a" }],
  ["memory_revise", "revise", { id: 2, expectedRevision: 1 }, { id: 2, expectedRevision: 1 }],
  ["memory_history", "history", { id: 2 }, 2],
] as const)(
  "%s forwards its request and serializes the store result",
  async (name, method, args, expected) => {
    store[method].mockReturnValue({ marker: name });
    expect(await call(name, args)).toBe(JSON.stringify({ marker: name }));
    expect(store[method]).toHaveBeenCalledExactlyOnceWith(expected);
  },
);

test("store failures propagate to the caller instead of appearing successful", async () => {
  store.setScope.mockImplementation(() => {
    throw new Error("stale revision");
  });
  await expect(call("memory_set_scope", { entityName: "router-a" })).rejects.toThrow(
    "stale revision",
  );
});

test("entity creation distinguishes created, duplicate, and empty input", async () => {
  const entities = [{ name: "router-a", entityType: "router" }];
  store.createEntities.mockReturnValueOnce(entities).mockReturnValueOnce([]);
  expect(await call("memory_create_entities", { entities })).toContain(
    "Created 1 entities:\n  - router-a (router)",
  );
  expect(store.createEntities).toHaveBeenCalledWith(entities);
  expect(await call("memory_create_entities", { entities })).toContain("all names already exist");
});

test("relation and observation responses include actual created records", async () => {
  const relations = [{ from: "router-a", to: "subnet-a", relationType: "serves" }];
  store.createRelations.mockReturnValueOnce(relations).mockReturnValueOnce([]);
  expect(await call("memory_create_relations", { relations })).toContain(
    "router-a --[serves]--> subnet-a",
  );
  expect(await call("memory_create_relations", { relations })).toContain("endpoints missing");
  const observations = [{ entityName: "router-a", contents: ["version 7"] }];
  store.addObservations
    .mockReturnValueOnce([{ entityName: "router-a", added: ["version 7"] }])
    .mockReturnValueOnce([]);
  expect(await call("memory_add_observations", { observations })).toContain(
    "router-a: +1 observations",
  );
  expect(await call("memory_add_observations", { observations })).toContain("all duplicates");
});

test.each([
  [
    "memory_delete_entities",
    "deleteEntities",
    { entityNames: ["router-a"] },
    "Deleted 2 entities",
    "No matching entities found.",
  ],
  [
    "memory_delete_observations",
    "deleteObservations",
    { deletions: [{ entityName: "router-a", observations: ["old"] }] },
    "Deleted 2 observations",
    "No matching observations found.",
  ],
  [
    "memory_delete_relations",
    "deleteRelations",
    { relations: [{ from: "a", to: "b", relationType: "serves" }] },
    "Deleted 2 relations",
    "No matching relations found.",
  ],
] as const)(
  "%s reports deletion count and zero-match result",
  async (name, method, args, positive, zero) => {
    store[method].mockReturnValueOnce(2).mockReturnValueOnce(0);
    expect(await call(name, args)).toContain(positive);
    expect(await call(name, args)).toBe(zero);
    expect(store[method]).toHaveBeenCalledWith(Object.values(args)[0]);
  },
);

test.each([
  ["memory_read_graph", "readGraph", {}, "The knowledge graph is empty."],
  [
    "memory_search_nodes",
    "searchNodes",
    { query: "missing", limit: 2 },
    'No entities matching "missing".',
  ],
  [
    "memory_open_nodes",
    "openNodes",
    { names: ["missing"] },
    "None of the requested entities exist.",
  ],
] as const)("%s distinguishes empty and populated graphs", async (name, method, args, empty) => {
  store[method]
    .mockReturnValueOnce({ entities: [], relations: [] })
    .mockReturnValueOnce({ entities: [{ name: "router-a" }], relations: [] });
  expect(await call(name, args)).toBe(empty);
  expect(JSON.parse((await call(name, args)) as string).entities).toEqual([{ name: "router-a" }]);
});

test("search preserves query and result limit", async () => {
  store.searchNodes.mockReturnValue({ entities: [], relations: [] });
  await call("memory_search_nodes", { query: "uplink", limit: 3 });
  expect(store.searchNodes).toHaveBeenCalledWith("uplink", 3);
});

test("memory schemas reject empty batches, invalid IDs, and invalid search limits", () => {
  const schema = (name: string) =>
    z.object(memoryTools.find((tool) => tool.name === name)!.inputSchema);
  expect(schema("memory_create_entities").safeParse({ entities: [] }).success).toBe(false);
  expect(schema("memory_history").safeParse({ id: 0 }).success).toBe(false);
  expect(schema("memory_search_nodes").safeParse({ query: "x", limit: -1 }).success).toBe(false);
});
