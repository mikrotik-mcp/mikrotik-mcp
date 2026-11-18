/** Certificates — `/certificate`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE, READ, DESTRUCTIVE, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const certificateTools: ToolModule = [
  defineTool({
    name: "list_certificates",
    title: "List Certificates",
    annotations: READ,
    description:
      "Lists certificates from the device certificate store (`/certificate`). " +
      "Use to browse all installed certificates — CA, TLS server, client, and self-signed — " +
      "along with their validity, fingerprint, and key-usage flags. " +
      "Returns all entries or those matching an optional partial `name_filter` on the certificate name. " +
      "For full detail on a single certificate use `get_certificate`.",
    inputSchema: {
      name_filter: z.string().optional().describe("Partial name match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing certificates");
      const filters: string[] = [];
      if (a.name_filter) filters.push(`name~${quoted(a.name_filter)}`);

      const result = await executeMikrotikCommand(`/certificate print${whereClause(filters)}`, ctx);
      return isEmpty(result)
        ? "No certificates found matching the criteria."
        : `CERTIFICATES:\n\n${result}`;
    },
  }),

  defineTool({
    name: "get_certificate",
    title: "Get Certificate Details",
    annotations: READ,
    description:
      "Retrieves full detail for a single named certificate (`/certificate print detail where name=...`). " +
      "Use to inspect a certificate's subject, issuer, expiry date, fingerprint, key-usage flags, and trust status. " +
      "Takes the certificate `name` as a string — use `list_certificates` to find available names. " +
      "For bulk browsing of all certificates use `list_certificates`.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Getting certificate details: name=${a.name}`);
      const result = await executeMikrotikCommand(
        `/certificate print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return isEmpty(result)
        ? `Certificate '${a.name}' not found.`
        : `CERTIFICATE DETAILS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "create_certificate",
    title: "Create Certificate Template",
    annotations: WRITE,
    description:
      "Creates an unsigned certificate template in the device store (`/certificate add`). " +
      "Use as the first step in generating a local PKI certificate — sets subject fields " +
      "(common-name, country, organization), RSA key size, validity period in days, and key-usage flags " +
      "(e.g. 'tls-server', 'key-cert-sign'). " +
      "The resulting certificate is NOT yet signed; call `sign_certificate` next to self-sign it " +
      "or sign it with a named CA certificate. " +
      "To register an externally generated cert/key file already on the device filesystem use `import_certificate`. " +
      "Returns the created certificate's full detail including its name.",
    inputSchema: {
      name: z.string().describe("Name for the certificate"),
      common_name: z.string().describe("Common name (CN), e.g. a hostname or domain"),
      key_size: z.number().int().default(2048).describe("RSA key size in bits"),
      days_valid: z.number().int().default(365).describe("Validity period in days"),
      key_usage: z.string().optional().describe("Comma-separated key usages, e.g. 'tls-server'"),
      country: z.string().optional().describe("Country code (C), e.g. 'US'"),
      state: z.string().optional().describe("State or province (ST)"),
      locality: z.string().optional().describe("Locality / city (L)"),
      organization: z.string().optional().describe("Organization (O)"),
      unit: z.string().optional().describe("Organizational unit (OU)"),
      subject_alt_name: z
        .string()
        .optional()
        .describe("Subject Alternative Name(s), e.g. 'DNS:example.com,IP:1.2.3.4'"),
      trusted: z
        .boolean()
        .optional()
        .describe("Whether the certificate is trusted for chain verification"),
    },
    async handler(a, ctx) {
      ctx.info(`Creating certificate: name=${a.name}`);
      const cmd = new Cmd("/certificate add")
        .set("name", a.name)
        .set("common-name", a.common_name)
        .opt("key-size", a.key_size)
        .opt("days-valid", a.days_valid)
        .opt("key-usage", a.key_usage)
        .opt("country", a.country)
        .opt("state", a.state)
        .opt("locality", a.locality)
        .opt("organization", a.organization)
        .opt("unit", a.unit)
        .opt("subject-alt-name", a.subject_alt_name)
        .bool("trusted", a.trusted)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to create certificate: ${result}`;

      const details = await executeMikrotikCommand(
        `/certificate print detail where name=${quoted(a.name)}`,
        ctx,
      );
      return details.trim()
        ? `Certificate created successfully:\n\n${details}`
        : "Certificate creation completed but unable to verify.";
    },
  }),

  defineTool({
    name: "sign_certificate",
    title: "Sign Certificate",
    annotations: WRITE,
    description:
      "Signs an existing certificate template (`/certificate sign`) to produce a valid certificate. " +
      "Omit `ca` to produce a self-signed certificate; supply the name of an existing CA certificate in `ca` " +
      "to issue it under that CA. " +
      "IMPORTANT: certificate stores are PER-DEVICE — the template (and the `ca`, if given) must live on the " +
      "SAME router this runs on. A 'CA not found' error almost always means the template or CA was created on a " +
      "different device; verify with list_certificates on this device first (and check the targeting). " +
      "Set the common name (CN) when you create the template (create_certificate), not here — `/certificate sign` " +
      "has no CN option. " +
      "May run for several seconds while the device generates key material. " +
      "Returns the signing operation output from the device.",
    inputSchema: {
      name: z.string().describe("Name of the certificate template to sign"),
      ca: z
        .string()
        .optional()
        .describe(
          "Name of the CA certificate to sign with (must exist on THIS device; omit to self-sign)",
        ),
    },
    async handler(a, ctx) {
      ctx.info(`Signing certificate: name=${a.name}${a.ca ? ` ca=${a.ca}` : " (self-signed)"}`);

      // Pre-flight: the template must exist ON THIS DEVICE. The most common
      // failure — and the real cause of a confusing "CA not found" even when
      // self-signing — is the template/CA having been created on a DIFFERENT
      // router (each device has its own certificate store). Diagnose that
      // clearly instead of letting RouterOS emit a cryptic error.
      const templateCount = await executeMikrotikCommand(
        `/certificate print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (templateCount.trim() === "0") {
        return (
          `Certificate template '${a.name}' was not found on this device. Certificate stores are per-device — ` +
          `create the template here first (create_certificate), and make sure you are targeting the router that holds it ` +
          `(use list_certificates / list_mikrotik_devices to confirm).`
        );
      }
      if (a.ca) {
        const caCount = await executeMikrotikCommand(
          `/certificate print count-only where name=${quoted(a.ca)}`,
          ctx,
        );
        if (caCount.trim() === "0") {
          return (
            `CA certificate '${a.ca}' was not found on this device. The signing CA must exist on the SAME router as ` +
            `the template (certificate stores are per-device). Omit 'ca' to self-sign, or create/import the CA on this device first.`
          );
        }
      }

      const cmd = new Cmd("/certificate sign").raw(a.name).opt("ca", a.ca).build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to sign certificate: ${result}`;
      return `Signing certificate '${a.name}'${a.ca ? ` with CA '${a.ca}'` : " (self-signed)"}…\n\n${result}`;
    },
  }),

  defineTool({
    name: "remove_certificate",
    title: "Remove Certificate",
    annotations: DESTRUCTIVE,
    description:
      "Permanently deletes a named certificate from the device store (`/certificate remove [find name=...]`). " +
      "Performs an existence check first and returns an error if the certificate is not found. " +
      "Removing a CA certificate will invalidate any leaf certificates it signed. " +
      "Use `list_certificates` to browse certificate names before removal.",
    inputSchema: { name: z.string() },
    async handler(a, ctx) {
      ctx.info(`Removing certificate: name=${a.name}`);
      const count = await executeMikrotikCommand(
        `/certificate print count-only where name=${quoted(a.name)}`,
        ctx,
      );
      if (count.trim() === "0") return `Certificate '${a.name}' not found.`;

      const result = await executeMikrotikCommand(
        `/certificate remove [find name=${quoted(a.name)}]`,
        ctx,
      );
      if (looksLikeError(result)) return `Failed to remove certificate: ${result}`;
      return `Certificate '${a.name}' removed successfully.`;
    },
  }),

  defineTool({
    name: "import_certificate",
    title: "Import Certificate from File",
    annotations: WRITE,
    description:
      "Imports a certificate or private key from a file already present on the device filesystem (`/certificate import`). " +
      "Use when you have uploaded a PEM, DER, or PKCS12 file to the device via FTP/SCP/Winbox and need to " +
      "register it in the certificate store. " +
      "Supply `passphrase` if the key is encrypted, and `name` to label the imported entry in the store. " +
      "To generate a certificate locally on the device instead use `create_certificate` followed by `sign_certificate`.",
    inputSchema: {
      file_name: z.string().describe("Name of the certificate/key file to import"),
      passphrase: z.string().optional().describe("Passphrase protecting the imported key, if any"),
      name: z.string().optional().describe("Name to assign to the imported certificate"),
    },
    async handler(a, ctx) {
      ctx.info(`Importing certificate from file: ${a.file_name}`);
      const cmd = new Cmd("/certificate import")
        .set("file-name", a.file_name)
        .opt("passphrase", a.passphrase)
        .opt("name", a.name)
        .build();

      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to import certificate: ${result}`;
      return `Certificate import completed:\n\n${result}`;
    },
  }),
];
