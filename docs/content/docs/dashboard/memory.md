---
title: "Memory"
description: "Evidence, lessons & relevant context across sessions"
---

## Keep useful network knowledge locally

Open **MCP workspace → Memory** (`#memory`). Knowledge is stored in SQLite on the MCP host, with evidence, confidence, expiry and revisions. It is context for an LLM, never permission to change a router.

### Knowledge library

Create an entity, then **Add memory** with one fact, constraint, lesson, preference or procedure. Supply its source, author-assessed confidence, optional stable key, pin and expiry. A repeated entity/key updates one fact while preserving history. Never store passwords or private keys.

Search entities or knowledge and filter by **Scope**, **Kind** and **Status**. Entity links expose related knowledge. The library displays 24 memories per page and refreshes every 30 seconds while visible. Summary cards open active, review, pinned or archived records.

### Review and revise

Open a card to inspect evidence, stable key, verification/expiry dates and revision history. **Edit memory** saves a revision. **Archive memory** removes it from recall while keeping history; **Restore memory** reactivates it.

In **Needs review**, **Verify & next** saves verification and advances to the next matching record without closing the dialog. Verification does not test a router, extend expiry or raise confidence. An expired/low-confidence record can still need editing after verification. If loading the next item fails, **Retry next memory** avoids verifying the same item again.

Deleting an entity requires confirmation and permanently removes its facts, revisions and relations. Prefer archiving individual records when history matters.

### Recall lab

Enter a task and choose a 3,000 / 6,000 / 16,000-character budget. Select an entity in the library to scope recall; related entities are optional references. **Preview context** shows the exact copyable LLM context, selection reasons, applicable scopes and conflicts. It neither calls a model nor runs router commands. Archived/expired records are excluded.

### Shared memory

Inspect an entity's scope or create a dedicated policy entity:

| Scope  | Included for                                  |
| ------ | --------------------------------------------- |
| Device | That entity only                              |
| Group  | Up to 100 explicitly selected device entities |
| Shared | Every device's recall                         |

Sharing applies to **all current and future memories of the entity** and requires confirmation when broadened. Keep router-specific addresses/settings in device entities. Device recall combines shared, explicit groups and device knowledge; conflicting stable keys are surfaced rather than silently overridden.

This is local relevance sharing, not cloud synchronization, tenant isolation or a permission system.

### Activity and settings

**Activity** lists the latest 50 knowledge changes. **Settings** enables/disables access and selects the database path. Disabling preserves data. Changing the path opens a different database; it does not move existing knowledge. Reconnect MCP clients after changing enablement so their instructions refresh.

## Screen preview

![Full-page dashboard preview with IP addresses and snapshot/backup names blurred](/screenshots/memory.jpg)

IP addresses, snapshot/backup names and AAA/OpenVPN usernames are blurred in this full-page capture.
