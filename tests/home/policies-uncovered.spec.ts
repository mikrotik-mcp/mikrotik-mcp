import { expect, test } from "vite-plus/test";
import { policyInput } from "../../src/home/model";
import { buildPolicy } from "../../src/home/policies";
import type { PolicyFacts } from "../../src/home/policies";

const id = "6f6fd83b-3f54-4395-845f-c99edbd6d3ab";
const input = policyInput.parse({ mac: "aa:bb:cc:dd:ee:ff", action: "pause" });
function facts(): PolicyFacts {
  return {
    deviceMode: { scheduler: "yes" },
    leases: [
      {
        address: "192.168.88.10",
        "mac-address": "AA:BB:CC:DD:EE:FF",
        status: "bound",
        dynamic: "no",
      },
    ],
    filters: [],
    connections: [],
    mangle: [],
    queues: [],
    tables: [],
    routes: [],
    addresses: [{ address: "192.168.88.1/24" }],
    ipv6: { "disable-ipv6": "yes" },
  };
}

test("rejects an overlapping lease address and a changed active address", () => {
  const f = facts();
  f.leases.push({ address: "192.168.88.10", "mac-address": "11:22:33:44:55:66" });
  expect(() => buildPolicy(id, input, f)).toThrow("IP is ambiguous");
  f.leases.pop();
  f.leases[0]["active-address"] = "192.168.88.11";
  expect(() => buildPolicy(id, input, f)).toThrow("lease changed");
});

test("requires exactly one suitable priority child and refuses non-leaf queues", () => {
  const f = facts();
  const priority = { ...input, action: "priority" as const };
  expect(() => buildPolicy(id, priority, f)).toThrow("finite parent/child");
  f.queues = [
    { name: "house", target: "192.168.88.0/24", "max-limit": "40M/180M" },
    {
      name: "laptop",
      target: "192.168.88.10/32",
      parent: "house",
      "max-limit": "10M/20M",
      priority: "8/8",
    },
    {
      name: "child",
      target: "192.168.88.11/32",
      parent: "laptop",
      "max-limit": "5M/5M",
      priority: "8/8",
    },
  ];
  expect(() => buildPolicy(id, priority, f)).toThrow("leaf queues");
  f.queues.pop();
  f.queues[1].priority = "1/1";
  expect(() => buildPolicy(id, priority, f)).toThrow("highest queue priority");
});

test("an inactive FIB table cannot be selected even if a default route exists", () => {
  const f = facts();
  f.tables = [{ name: "backup", fib: "no" }];
  f.routes = [{ "routing-table": "backup", "dst-address": "0.0.0.0/0", active: "yes" }];
  expect(() => buildPolicy(id, { ...input, action: "route", table: "backup" }, f)).toThrow(
    "enabled FIB table",
  );
});
