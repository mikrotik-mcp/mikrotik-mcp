/** SMS over an LTE/modem channel — `/tool sms`. */
import { z } from "zod";
import { executeMikrotikCommand } from "../core/connector";
import { WRITE_IDEMPOTENT, WRITE, READ, defineTool } from "../core/registry";
import type { ToolModule } from "../core/registry";
import { whereClause, looksLikeError, isEmpty, Cmd, quoted } from "../core/routeros";

export const smsTools: ToolModule = [
  defineTool({
    name: "get_sms_settings",
    title: "Get SMS Tool Settings",
    annotations: READ,
    description:
      "Read SMS tool configuration (`/tool sms print`) — returns the active settings for the device's " +
      "LTE/modem SMS subsystem, including assigned port, receive-enabled flag, allowed-number, " +
      "secret, channel, and SIM PIN status. Use this to inspect the current state before making " +
      "changes. To modify these settings use update_sms_settings; to view received messages use " +
      "list_sms_inbox; to send a message use send_sms.",
    async handler(_a, ctx) {
      ctx.info("Getting sms settings");
      const result = await executeMikrotikCommand("/tool sms print", ctx);
      return isEmpty(result) ? "Unable to read sms settings." : `SMS SETTINGS:\n\n${result}`;
    },
  }),

  defineTool({
    name: "update_sms_settings",
    title: "Update SMS Tool Settings",
    annotations: WRITE_IDEMPOTENT,
    description:
      "Configure the SMS tool (`/tool sms set`) — sets the LTE/modem port and reception options " +
      "used for sending and receiving SMS on the device. Supply one or more fields to change: " +
      "port (LTE/modem interface for SMS, e.g. 'lte1'), receive_enabled (store incoming SMS in " +
      "the inbox), secret (passcode required for remote SMS commands), allowed_number (restrict " +
      "remote command acceptance to this phone number only), channel, sim_pin. Returns the " +
      "resulting settings via print. To read current settings without modifying them use " +
      "get_sms_settings.",
    inputSchema: {
      port: z.string().optional().describe("LTE/modem port, e.g. 'lte1'"),
      receive_enabled: z.boolean().optional(),
      secret: z.string().optional().describe("Secret for remote SMS commands"),
      allowed_number: z.string().optional(),
      channel: z.number().int().optional(),
      sim_pin: z.string().optional(),
    },
    async handler(a, ctx) {
      // secret / sim_pin intentionally not logged.
      ctx.info("Updating sms settings");
      const cmd = new Cmd("/tool sms set")
        .opt("port", a.port)
        .bool("receive-enabled", a.receive_enabled)
        .opt("secret", a.secret)
        .opt("allowed-number", a.allowed_number)
        .opt("channel", a.channel)
        .opt("sim-pin", a.sim_pin);

      const built = cmd.build();
      if (built === "/tool sms set") return "No updates specified.";

      const result = await executeMikrotikCommand(built, ctx);
      if (looksLikeError(result)) return `Failed to update sms settings: ${result}`;
      const details = await executeMikrotikCommand("/tool sms print", ctx);
      return `SMS settings updated successfully:\n\n${details}`;
    },
  }),

  defineTool({
    name: "send_sms",
    title: "Send SMS Message",
    annotations: WRITE,
    description:
      "Send an SMS message via the device's LTE/modem interface (`/tool sms send`). Requires " +
      "port (LTE/modem interface, e.g. 'lte1'), phone_number (destination in international or " +
      "local format), and message text; optionally accepts smsc (SMS service center number to " +
      "override the SIM default) and channel. Returns a confirmation string on success. The " +
      "sending port and defaults are configured via update_sms_settings; to view received " +
      "replies use list_sms_inbox.",
    inputSchema: {
      port: z.string().describe("LTE/modem port, e.g. 'lte1'"),
      phone_number: z.string().describe("Destination phone number"),
      message: z.string().describe("Message text"),
      smsc: z.string().optional().describe("SMS service center number"),
      channel: z.number().int().optional(),
    },
    async handler(a, ctx) {
      ctx.info(`Sending SMS via ${a.port} to ${a.phone_number}`);
      const cmd = new Cmd("/tool sms send")
        .set("port", a.port)
        .set("phone-number", a.phone_number)
        .set("message", a.message)
        .opt("smsc", a.smsc)
        .opt("channel", a.channel)
        .build();
      const result = await executeMikrotikCommand(cmd, ctx);
      if (looksLikeError(result)) return `Failed to send SMS: ${result}`;
      return `SMS sent to ${a.phone_number}.`;
    },
  }),

  defineTool({
    name: "list_sms_inbox",
    title: "List SMS Inbox Messages",
    annotations: READ,
    description:
      "List received SMS messages stored in the device inbox (`/tool sms inbox print`). " +
      "Optionally filter by partial sender phone number via phone_filter. Returns all matching " +
      "inbox entries including sender, timestamp, and message text. Inbox population requires " +
      "receive_enabled=true, set via update_sms_settings. To send an outbound message use " +
      "send_sms.",
    inputSchema: {
      phone_filter: z.string().optional().describe("Partial sender match"),
    },
    async handler(a, ctx) {
      ctx.info("Listing sms inbox");
      const filters: string[] = [];
      if (a.phone_filter) filters.push(`phone~${quoted(a.phone_filter)}`);

      const result = await executeMikrotikCommand(
        `/tool sms inbox print${whereClause(filters)}`,
        ctx,
      );
      return isEmpty(result)
        ? "No SMS messages found matching the criteria."
        : `SMS INBOX:\n\n${result}`;
    },
  }),
];
