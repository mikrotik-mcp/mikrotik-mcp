import { expect, test } from "vite-plus/test";
import {
  clientIdentifier,
  filterClientOptions,
} from "../../ui/observability/investigation-client-options";

const clients = [
  { host: "Office laptop", ip: "192.0.2.10", mac: "AA:BB:CC:DD:EE:01", iface: "bridge" },
  { host: "Phone", ip: "", mac: "AA:BB:CC:DD:EE:02", iface: "wifi" },
];
test("defaults to all clients and supports name, IP, MAC and interface searches", () => {
  expect(filterClientOptions(clients, "")).toHaveLength(2);
  for (const query of ["OFFICE", "192.0.2.10", "ee:01", " bridge "])
    expect(filterClientOptions(clients, query)).toEqual([clients[0]]);
  expect(filterClientOptions(clients, "missing")).toEqual([]);
});
test("selection emits a valid address, never the display name", () => {
  expect(clientIdentifier(clients[0])).toBe("192.0.2.10");
  expect(clientIdentifier(clients[1])).toBe("AA:BB:CC:DD:EE:02");
  expect(clientIdentifier({ ...clients[0], ip: "999.0.2.1" })).toBe(clients[0].mac);
  expect(clientIdentifier({ ...clients[0], ip: "::1", mac: "bad" })).toBe("");
});
test("invalid records are not offered and filtering does not mutate source ordering", () => {
  const records = [clients[1], clients[0], { ...clients[0], ip: "", mac: "" }];
  expect(filterClientOptions(records, "")).toEqual(clients);
  expect(records[0]).toBe(clients[1]);
});
