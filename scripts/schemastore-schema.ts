import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { z } from "zod";
import { MikrotikConfigSchema } from "../src/config";

type Schema = z.core.JSONSchema.JSONSchema;

function object(schema: Schema | boolean | undefined): Schema {
  if (!schema || typeof schema !== "object" || schema.type !== "object")
    throw new Error("Unexpected configuration schema shape. Check the SchemaStore projection.");
  return schema;
}

export function schemaStoreConfig(revision: string): Schema {
  const input = z.toJSONSchema(MikrotikConfigSchema, {
    target: "draft-7",
    io: "input",
    override({ jsonSchema: node }) {
      if (
        typeof node.default === "object" ||
        (typeof node.default === "string" && node.default.startsWith(homedir()))
      )
        delete node.default;
    },
  });
  const { $schema, ...structured } = input;
  const props = structured.properties!;
  const devices = object(props.devices);
  const device = object(devices.additionalProperties);
  devices.additionalProperties = { $ref: "#/definitions/device" };
  for (const [key, description] of Object.entries({
    serviceProbes: "Approved service probe targets and scheduled checks.",
    devices: "Named routers and their management connection settings.",
    defaultDevice: "Name of the router used when a tool call does not specify a device.",
    mcp: "MCP transport, listening address and client access settings.",
    dashboard: "Optional local observability dashboard and storage settings.",
    ssh: "SSH connection pool settings.",
    readOnly: "Expose only read-only tools when enabled.",
    tools: "Limit the tools and modules exposed to MCP clients.",
    memory: "Persistent network knowledge and memory settings.",
    passwordFrom:
      "Read the router password from an env:NAME, file:path, or keyring:service/account reference.",
    keyPassphraseFrom:
      "Read the private key passphrase from an env:NAME, file:path, or keyring:service/account reference.",
    sshAgent: "Use the SSH agent available through SSH_AUTH_SOCK.",
    hostKeySha256: "Pin the SSH server host key by its SHA-256 fingerprint.",
  })) {
    const node = props[key] ?? device.properties?.[key];
    if (typeof node === "object") node.description ??= description;
  }
  // The file loader selects the structured form by the presence of "devices".
  structured.properties = {
    $schema: {
      type: "string",
      format: "uri",
      description: "JSON Schema used by editors to validate this configuration.",
    },
    ...props,
  };
  structured.required = [...new Set(["devices", ...(structured.required ?? [])])];
  // Zod's custom refinement is not emitted by toJSONSchema.
  const issuer = object(object(props.vouchers).properties?.issue);
  issuer.anyOf = ["token", "tokenFrom"].map((key) => ({
    required: [key],
    properties: { [key]: {} },
  }));
  return {
    $schema,
    $id: "https://www.schemastore.org/mikrotik-mcp.json",
    $comment: `Derived from MikrotikConfigSchema (Zod input, draft-7) in https://github.com/mikrotik-mcp/mikrotik-mcp/blob/${revision}/src/config.ts. Resolved object defaults and host-specific paths are omitted. Supports structured configuration and legacy bare device maps. Voucher issuance requires token or tokenFrom, as checked by the runtime refinement.`,
    title: "MikroTik MCP configuration",
    description:
      "Configuration for @usex/mikrotik-mcp. Use the structured devices form when including $schema or server settings.\nhttps://mikrotik-mcp.usestrict.dev/docs/guides/configuration",
    type: "object",
    anyOf: [
      structured,
      {
        type: "object",
        not: { required: ["devices"] },
        additionalProperties: { $ref: "#/definitions/device" },
      },
    ],
    definitions: { device },
  };
}

export function sameConfigSchema(left: Schema, right: Schema): boolean {
  // A new release SHA alone is not an editor-visible change.
  return isDeepStrictEqual({ ...left, $comment: undefined }, { ...right, $comment: undefined });
}
