import { expect, test } from "vite-plus/test";
import { schemaStoreConfig, sameConfigSchema } from "../scripts/schemastore-schema";

test("uses config-file inputs for structured files and legacy device maps", () => {
  const schema = schemaStoreConfig("release-sha");
  const [structured, legacy] = schema.anyOf!;
  expect(structured.required).toEqual(["devices"]);
  expect(structured.properties!.devices).toMatchObject({
    additionalProperties: { $ref: "#/definitions/device" },
  });
  expect(legacy).toMatchObject({
    not: { required: ["devices"] },
    additionalProperties: { $ref: "#/definitions/device" },
  });
  expect(schema.definitions).toMatchObject({
    device: { properties: { sshAgent: { type: "boolean" }, passwordFrom: { type: "string" } } },
  });
  expect(structured.properties!.vouchers).toMatchObject({
    properties: { issue: { anyOf: [{ required: ["token"] }, { required: ["tokenFrom"] }] } },
  });
  expect(structured.properties!.feedback).not.toHaveProperty("default");
  expect(structured.properties!.feedback).toMatchObject({
    properties: { dbPath: { type: "string" } },
  });
  expect(structured.properties!.feedback).not.toHaveProperty("properties.dbPath.default");
});

test("ignores key order and source revision while detecting changes to option values", () => {
  const old = schemaStoreConfig("old");
  const next = schemaStoreConfig("new");
  expect(sameConfigSchema(old, Object.fromEntries(Object.entries(next).reverse()))).toBe(true);
  next.anyOf![0].properties!.verifyWrites = { type: "boolean", default: "changed" };
  expect(sameConfigSchema(old, next)).toBe(false);
});
