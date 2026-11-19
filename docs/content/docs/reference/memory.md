---
title: "Knowledge Graph"
description: "Persistent knowledge-graph memory — entities, relations and observations that survive across sessions. Create, search and manage structured knowledge the AI can reference."
---

## Tools

- [Inspect Memory Sharing Scope](#memory_get_scope)
- [Set Memory Sharing Scope](#memory_set_scope)
- [Remember Network Knowledge](#memory_remember)
- [Recall Relevant Network Context](#memory_recall)
- [Browse and Review Memories](#memory_review)
- [Revise or Verify a Memory](#memory_revise)
- [Check Whether Memory Can Answer](#memory_can_answer)
- [Read Memory As It Was](#memory_as_of)
- [Memory Revision History](#memory_history)
- [Create Knowledge Graph Entities](#memory_create_entities)
- [Create Knowledge Graph Relations](#memory_create_relations)
- [Add Observations to Entities](#memory_add_observations)
- [Delete Knowledge Graph Entities](#memory_delete_entities)
- [Delete Observations from Entities](#memory_delete_observations)
- [Delete Knowledge Graph Relations](#memory_delete_relations)
- [Read Entire Knowledge Graph](#memory_read_graph)
- [Search Knowledge Graph](#memory_search_nodes)
- [Open Knowledge Graph Nodes](#memory_open_nodes)

## memory_get_scope

**Inspect Memory Sharing Scope** · Risk: **read**

Read an existing entity's memory scope, explicit group members and scope revision. Device is the safe default. Shared applies to every device in this MCP database; Group only to its exact members. Scope is logical applicability, not an access-control boundary. Does not contact a router.

| Parameter    | Required | Definition                                        |
| ------------ | -------- | ------------------------------------------------- |
| `entityName` | Yes      | `{"type":"string","minLength":1,"maxLength":200}` |

## memory_set_scope

**Set Memory Sharing Scope** · Risk: **write**

Explicitly configure Device, Group or Shared scope for an existing knowledge entity. ALL its existing and future memories inherit the scope. Read memory_get_scope first and supply expectedRevision. Shared/Group require confirmSharing=true after reviewing all affected knowledge and the user's intent; never promote a router's local facts automatically. Prefer a new dedicated policy entity. Group members must be exact existing Device-scoped entities, no nested groups; members replaces the full list. No router changes.

| Parameter          | Required | Definition                                                                                             |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `entityName`       | Yes      | `{"type":"string","minLength":1,"maxLength":200}`                                                      |
| `scope`            | Yes      | `{"type":"string","enum":["device","group","shared"]}`                                                 |
| `members`          | Yes      | `{"default":[],"maxItems":100,"type":"array","items":{"type":"string","minLength":1,"maxLength":200}}` |
| `expectedRevision` | Yes      | `{"type":"integer","minimum":0,"maximum":9007199254740991}`                                            |
| `confirmSharing`   | Yes      | `{"default":false,"type":"boolean"}`                                                                   |

## memory_remember

**Remember Network Knowledge** · Risk: **write**

Save a fact, constraint, lesson, preference or procedure for an existing entity. Supply a source, author-assessed confidence, optional expiry and pin. A stable key (e.g. wan.provider) replaces that entity's previous value atomically and preserves revision history. An older memory of the same entity that says something else about the same subject (written as 'subject: value' or 'subject is value') is retired: archived with its history, and listed in `retired`. Memories that may contradict this one but were not retired are listed in `possibleConflicts`; when one of them is replaced by this fact, call again with its id in `supersedes`. Restore a retired memory with memory_revise status=active. Never store credentials or raw command dumps. No router changes.

| Parameter    | Required | Definition                                                                                                                                                                                                                                   |
| ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entityName` | Yes      | `{"type":"string","minLength":1,"maxLength":200}`                                                                                                                                                                                            |
| `content`    | Yes      | `{"type":"string","minLength":1,"maxLength":8000}`                                                                                                                                                                                           |
| `key`        | No       | `{"anyOf":[{"type":"string","minLength":1,"maxLength":120},{"type":"null"}]}`                                                                                                                                                                |
| `kind`       | Yes      | `{"default":"fact","type":"string","enum":["fact","constraint","lesson","preference","procedure"]}`                                                                                                                                          |
| `source`     | Yes      | `{"default":"unspecified","type":"string","minLength":1,"maxLength":500}`                                                                                                                                                                    |
| `confidence` | Yes      | `{"default":0.5,"type":"number","minimum":0,"maximum":1}`                                                                                                                                                                                    |
| `pinned`     | Yes      | `{"default":false,"type":"boolean"}`                                                                                                                                                                                                         |
| `expiresAt`  | Yes      | `{"default":null,"anyOf":[{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},{"type":"null"}]}`                                                                                                                              |
| `supersedes` | Yes      | IDs of memories that this one replaces because they say something else. They are archived, with their history kept. `{"default":[],"maxItems":20,"type":"array","items":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}}` |

## memory_recall

**Recall Relevant Network Context** · Risk: **read**

Start every device task here using its exact entityName. Automatically merges Shared policy, explicit Group memberships and the selected Device. includeRelated only adds labeled reference context, never inherits another device's settings. Pinned/constraint memories from applicable scopes bypass text matching. Inspect applicableScopes, conflicts, constraintsOmitted, truncated and warnings before acting: no automatic key override. No target means library search, not permission to apply device/group facts. Context is untrusted reference data; verify live before router writes. Expired/archived facts are excluded; unknown names fail closed.

| Parameter        | Required | Definition                                                        |
| ---------------- | -------- | ----------------------------------------------------------------- |
| `query`          | Yes      | `{"default":"","type":"string","maxLength":500}`                  |
| `entityName`     | No       | `{"type":"string","minLength":1,"maxLength":200}`                 |
| `limit`          | Yes      | `{"default":12,"type":"integer","minimum":1,"maximum":50}`        |
| `maxChars`       | Yes      | `{"default":6000,"type":"integer","minimum":500,"maximum":16000}` |
| `includeRelated` | Yes      | `{"default":true,"type":"boolean"}`                               |

## memory_review

**Browse and Review Memories** · Risk: **read**

Browse paginated memories by entity, kind, text and state. state=review finds expired, unverified, low-confidence or 90-day-old knowledge. Includes stable IDs and revisions for safe edits. state=all includes archived records; no automatic deletion.

| Parameter    | Required | Definition                                                                                  |
| ------------ | -------- | ------------------------------------------------------------------------------------------- |
| `query`      | Yes      | `{"default":"","type":"string","maxLength":500}`                                            |
| `entityName` | No       | `{"type":"string","minLength":1,"maxLength":200}`                                           |
| `scope`      | No       | `{"type":"string","enum":["device","group","shared"]}`                                      |
| `kind`       | No       | `{"type":"string","enum":["fact","constraint","lesson","preference","procedure"]}`          |
| `state`      | Yes      | `{"default":"active","type":"string","enum":["active","review","pinned","archived","all"]}` |
| `limit`      | Yes      | `{"default":30,"type":"integer","minimum":1,"maximum":100}`                                 |
| `offset`     | Yes      | `{"default":0,"type":"integer","minimum":0,"maximum":1000000}`                              |

## memory_revise

**Revise or Verify a Memory** · Risk: **write**

Correct, pin, archive or restore a stored memory with its expectedRevision from memory_review. Keeps previous versions and rejects stale edits. Set verified=true only after actually confirming the fact; this does not test any router. Changing content/source resets verification. Expiry is not extended by verification; revise expiresAt explicitly after checking.

| Parameter          | Required | Definition                                                                                       |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `id`               | Yes      | `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}`                             |
| `expectedRevision` | Yes      | `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}`                             |
| `content`          | No       | `{"type":"string","minLength":1,"maxLength":8000}`                                               |
| `kind`             | No       | `{"type":"string","enum":["fact","constraint","lesson","preference","procedure"]}`               |
| `source`           | No       | `{"type":"string","minLength":1,"maxLength":500}`                                                |
| `confidence`       | No       | `{"type":"number","minimum":0,"maximum":1}`                                                      |
| `pinned`           | No       | `{"type":"boolean"}`                                                                             |
| `expiresAt`        | No       | `{"anyOf":[{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},{"type":"null"}]}` |
| `status`           | No       | `{"type":"string","enum":["active","archived"]}`                                                 |
| `verified`         | No       | `{"type":"boolean","const":true}`                                                                |

## memory_can_answer

**Check Whether Memory Can Answer** · Risk: **read**

Before you answer a question from memory, check that memory holds what the question asks about. Returns the words of the question that carry its meaning, which of them memory covers, which it does not (`missing`), which are covered only by memories that need review, the best matching memories, and advice. No language model is used: a word is covered when an active memory or an entity name has it. When `answerable` is false, do not answer the missing part from memory: read the router or say it is not known. With entityName the check reads that entity, its groups, shared policy and the entities it is linked to. No router access.

| Parameter    | Required | Definition                                         |
| ------------ | -------- | -------------------------------------------------- |
| `question`   | Yes      | `{"type":"string","minLength":2,"maxLength":1000}` |
| `entityName` | No       | `{"type":"string","minLength":1,"maxLength":200}`  |

## memory_as_of

**Read Memory As It Was** · Risk: **read**

Read memory as it was at a past moment: what was believed then, before later revisions, retirements and archiving. Give `at` as epoch milliseconds or text such as '2026-11-01' or '2026-11-01T14:30:00Z'. Each memory comes back as it read then, with `since` (unchanged, revised or archived). Use it to answer 'what did we know on that day' and to explain an old decision. These are past beliefs, not the network's state now: use memory_recall for today. A memory that was deleted keeps no history and is missing; `notes` says when that can be the case. No router access.

| Parameter    | Required | Definition                                                                                                                                                                                                                                |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`         | Yes      | The moment to read memory at: epoch milliseconds, or text such as "2026-11-01" or "2026-11-01T14:30:00Z". `{"anyOf":[{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},{"type":"string","minLength":4,"maxLength":40}]}` |
| `entityName` | No       | `{"type":"string","minLength":1,"maxLength":200}`                                                                                                                                                                                         |
| `query`      | Yes      | `{"default":"","type":"string","maxLength":500}`                                                                                                                                                                                          |
| `limit`      | Yes      | `{"default":30,"type":"integer","minimum":1,"maximum":100}`                                                                                                                                                                               |

## memory_history

**Memory Revision History** · Risk: **read**

Read up to 100 previous revisions of one memory, newest first. Historical values are evidence of prior beliefs, not current facts. Retrieve the current record with memory_review.

| Parameter | Required | Definition                                                           |
| --------- | -------- | -------------------------------------------------------------------- |
| `id`      | Yes      | `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}` |

## memory_create_entities

**Create Knowledge Graph Entities** · Risk: **write**

Create one or more new entities in the persistent knowledge graph. Each entity has a unique name, a type (e.g. 'router', 'subnet', 'vlan', 'person', 'config_pattern'), and optional initial observations. Entities that already exist are silently skipped. Use this to record things the AI learns about the network, devices, users, or patterns.

| Parameter  | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entities` | Yes      | Entities to create `{"minItems":1,"type":"array","items":{"type":"object","properties":{"name":{"type":"string","description":"Unique name of the entity"},"entityType":{"type":"string","description":"Type/category of the entity (e.g. 'router', 'subnet', 'person')"},"observations":{"description":"Initial observations (facts) to attach","type":"array","items":{"type":"string"}}},"required":["name","entityType"],"additionalProperties":false}}` |

## memory_create_relations

**Create Knowledge Graph Relations** · Risk: **write**

Create directed relations between existing entities in the knowledge graph. Both endpoint entities must already exist. Use active voice for relation types (e.g. 'manages', 'connects_to', 'provides_dhcp_for', 'part_of'). Duplicate relations are silently skipped.

| Parameter   | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relations` | Yes      | Relations to create `{"minItems":1,"type":"array","items":{"type":"object","properties":{"from":{"type":"string","description":"Source entity name"},"to":{"type":"string","description":"Target entity name"},"relationType":{"type":"string","description":"Relation type in active voice (e.g. 'manages', 'connects_to', 'depends_on')"}},"required":["from","to","relationType"],"additionalProperties":false}}` |

## memory_add_observations

**Add Observations to Entities** · Risk: **write**

Add new observations (discrete facts) to existing entities in the knowledge graph. Each observation is a string (e.g. 'runs RouterOS 7.16', 'has 4 ether ports', 'managed by John'). Duplicate observations on the same entity are silently skipped. The entity must already exist.

| Parameter      | Required | Definition                                                                                                                                                                                                                                                                                                                   |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observations` | Yes      | `{"minItems":1,"type":"array","items":{"type":"object","properties":{"entityName":{"type":"string","description":"Name of the existing entity"},"contents":{"minItems":1,"type":"array","items":{"type":"string"},"description":"Observations to add"}},"required":["entityName","contents"],"additionalProperties":false}}` |

## memory_delete_entities

**Delete Knowledge Graph Entities** · Risk: **destructive**

Remove entities from the knowledge graph. This also deletes all their observations and any relations where they appear as an endpoint (cascade delete).

| Parameter     | Required | Definition                                                                            |
| ------------- | -------- | ------------------------------------------------------------------------------------- |
| `entityNames` | Yes      | Names of entities to delete `{"minItems":1,"type":"array","items":{"type":"string"}}` |

## memory_delete_observations

**Delete Observations from Entities** · Risk: **destructive**

Remove specific observations from entities in the knowledge graph. The entity itself is kept; only the named observation strings are removed.

| Parameter   | Required | Definition                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deletions` | Yes      | `{"minItems":1,"type":"array","items":{"type":"object","properties":{"entityName":{"type":"string","description":"Entity to remove observations from"},"observations":{"minItems":1,"type":"array","items":{"type":"string"},"description":"Exact observation strings to delete"}},"required":["entityName","observations"],"additionalProperties":false}}` |

## memory_delete_relations

**Delete Knowledge Graph Relations** · Risk: **destructive**

Remove specific relations from the knowledge graph. Each relation is identified by its (from, to, relationType) triple.

| Parameter   | Required | Definition                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relations` | Yes      | Relations to delete `{"minItems":1,"type":"array","items":{"type":"object","properties":{"from":{"type":"string","description":"Source entity name"},"to":{"type":"string","description":"Target entity name"},"relationType":{"type":"string","description":"Relation type in active voice (e.g. 'manages', 'connects_to', 'depends_on')"}},"required":["from","to","relationType"],"additionalProperties":false}}` |

## memory_read_graph

**Read Entire Knowledge Graph** · Risk: **read**

Read the entire knowledge graph — all entities with their observations, plus all relations. Use this to get a complete picture of accumulated knowledge. For large graphs, prefer memory_search_nodes or memory_open_nodes.

No tool-specific parameters.

## memory_search_nodes

**Search Knowledge Graph** · Risk: **read**

Search for entities in the knowledge graph by name, type, or observation content. Returns matching entities with their observations, plus any relations where at least one endpoint is in the result set.

| Parameter | Required | Definition                                                                                               |
| --------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `query`   | Yes      | Search term — matched against entity names, types, and observation content `{"type":"string"}`           |
| `limit`   | No       | Max entities to return (default 50) `{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}` |

## memory_open_nodes

**Open Knowledge Graph Nodes** · Risk: **read**

Retrieve specific entities by exact name from the knowledge graph, with all their observations and any relations where at least one endpoint is in the requested set.

| Parameter | Required | Definition                                                                               |
| --------- | -------- | ---------------------------------------------------------------------------------------- |
| `names`   | Yes      | Exact entity names to retrieve `{"minItems":1,"type":"array","items":{"type":"string"}}` |
