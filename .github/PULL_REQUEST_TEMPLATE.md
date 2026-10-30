<!-- Thanks for contributing to @usex/mikrotik-mcp! -->

## What does this change?

A short description of the change and why it's needed.

Closes #

## Type of change

- [ ] New tool / module (a RouterOS subsystem)
- [ ] Change to an existing tool (new param, fix, behaviour)
- [ ] VPN / tunneling coverage
- [ ] New guided prompt (`prompts/`)
- [ ] Transport / connection / CLI
- [ ] Docs only
- [ ] Build / CI / tooling

## For tool changes

- [ ] Tool `name`s are snake_case and stable (existing names unchanged)
- [ ] Each tool has a `title`, a clear `description`, and a correct risk preset
      (`READ` / `WRITE` / `WRITE_IDEMPOTENT` / `DESTRUCTIVE` / `DANGEROUS`)
- [ ] User values go through the `Cmd` builder / are quoted (no raw interpolation)
- [ ] I ran `bun run gen` and committed the updated schemas and generated website references

**RouterOS commands this runs** (so reviewers can verify):

```
/interface vlan add name=... vlan-id=...
```

How I verified it (device model + RouterOS version, or why no device was needed):

## Checklist

- [ ] `bun run lint` passes
- [ ] `bun run test:types` passes
- [ ] `bun run test` passes
- [ ] `bun run build` succeeds
- [ ] Docs updated if behaviour or configuration changed
