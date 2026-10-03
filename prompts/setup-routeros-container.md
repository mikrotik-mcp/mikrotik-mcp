---
name: setup-routeros-container
title: Plan and safely deploy a RouterOS container
description: Version-aware image, storage, isolated VETH network and lifecycle workflow with explicit approval and application verification.
arguments:
  - name: device
    description: Exact configured router; omit to discover and ask.
    required: false
  - name: image
    description: Reviewed image and pinned version/digest, or uploaded image archive.
    required: false
  - name: requirements
    description: Application, client access, ports, persistent data and downtime constraints.
    required: false
---

Target {{device}}; image {{image}}; requirements {{requirements}}.
Start with READ-ONLY discovery following the shared container guide. Ask for
missing workload/access requirements. Verify architecture, package/device-mode,
storage, syntax and resources before proposing any command.

Prepare an explicit plan with image trust, volume backup, dedicated VETH/bridge or
VLAN, dual-stack allowed-flow matrix, positive WAN egress, shared-list consumers,
management preservation and recovery. No changes until the operator approves it.
Package/reboot/physical-confirmation steps require separate approval and scheduling.

Use describe_tool for the actual schema, including list vs legacy name and
envlists vs envlist. Do not guess a modern inline mount expression from Docker
examples. Keep secrets outside reports and Memory. Back up approved router changes
and application volumes separately; Safe Mode is not filesystem rollback.

After an approved add, poll a bounded number of times until fully stopped, then
start the exact .id. If a command times out, inspect before retrying. Test the
service from an intended client, deny an unintended source, and check both IP
families. Only then enable start-on-boot if approved. Report every pending/unknown
check; do not perform a reboot merely to test persistence without permission.
