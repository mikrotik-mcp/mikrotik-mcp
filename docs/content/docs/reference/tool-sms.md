---
title: "SMS"
description: "Send/receive SMS over an LTE modem (`/tool sms`)."
---

## Tools

- [Get SMS Tool Settings](#get_sms_settings)
- [Update SMS Tool Settings](#update_sms_settings)
- [Send SMS Message](#send_sms)
- [List SMS Inbox Messages](#list_sms_inbox)

## get_sms_settings

**Get SMS Tool Settings** · Risk: **read**

Read SMS tool configuration (`/tool sms print`) — returns the active settings for the device's LTE/modem SMS subsystem, including assigned port, receive-enabled flag, allowed-number, secret, channel, and SIM PIN status. Use this to inspect the current state before making changes. To modify these settings use update_sms_settings; to view received messages use list_sms_inbox; to send a message use send_sms.

No tool-specific parameters.

## update_sms_settings

**Update SMS Tool Settings** · Risk: **write-idempotent**

Configure the SMS tool (`/tool sms set`) — sets the LTE/modem port and reception options used for sending and receiving SMS on the device. Supply one or more fields to change: port (LTE/modem interface for SMS, e.g. 'lte1'), receive_enabled (store incoming SMS in the inbox), secret (passcode required for remote SMS commands), allowed_number (restrict remote command acceptance to this phone number only), channel, sim_pin. Returns the resulting settings via print. To read current settings without modifying them use get_sms_settings.

| Parameter         | Required | Definition                                                                  |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `port`            | No       | LTE/modem port, e.g. 'lte1' `{"type":"string"}`                             |
| `receive_enabled` | No       | `{"type":"boolean"}`                                                        |
| `secret`          | No       | Secret for remote SMS commands `{"type":"string"}`                          |
| `allowed_number`  | No       | `{"type":"string"}`                                                         |
| `channel`         | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |
| `sim_pin`         | No       | `{"type":"string"}`                                                         |

## send_sms

**Send SMS Message** · Risk: **write**

Send an SMS message via the device's LTE/modem interface (`/tool sms send`). Requires port (LTE/modem interface, e.g. 'lte1'), phone_number (destination in international or local format), and message text; optionally accepts smsc (SMS service center number to override the SIM default) and channel. Returns a confirmation string on success. The sending port and defaults are configured via update_sms_settings; to view received replies use list_sms_inbox.

| Parameter      | Required | Definition                                                                  |
| -------------- | -------- | --------------------------------------------------------------------------- |
| `port`         | Yes      | LTE/modem port, e.g. 'lte1' `{"type":"string"}`                             |
| `phone_number` | Yes      | Destination phone number `{"type":"string"}`                                |
| `message`      | Yes      | Message text `{"type":"string"}`                                            |
| `smsc`         | No       | SMS service center number `{"type":"string"}`                               |
| `channel`      | No       | `{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}` |

## list_sms_inbox

**List SMS Inbox Messages** · Risk: **read**

List received SMS messages stored in the device inbox (`/tool sms inbox print`). Optionally filter by partial sender phone number via phone_filter. Returns all matching inbox entries including sender, timestamp, and message text. Inbox population requires receive_enabled=true, set via update_sms_settings. To send an outbound message use send_sms.

| Parameter      | Required | Definition                               |
| -------------- | -------- | ---------------------------------------- |
| `phone_filter` | No       | Partial sender match `{"type":"string"}` |
