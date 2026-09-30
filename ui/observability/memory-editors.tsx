import { useState } from "react";
import type { FormEvent } from "react";
import { BookmarkPlus, Link2, Save } from "lucide-react";
import { memoryKinds } from "../../src/memory/knowledge";
import type { MemoryFact } from "../../src/memory/knowledge";
import { postJson } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export async function saveMemory<T>(path: string, body: unknown): Promise<T> {
  const result = await postJson<T & { error?: string }>(path, body);
  if (result.error) throw new Error(result.error);
  return result;
}

export function MemorySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="memory-field">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export function MemoryEditor({
  fact,
  entityName,
  onClose,
  onSaved,
}: {
  fact?: MemoryFact;
  entityName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [entity, setEntity] = useState(fact?.entityName ?? entityName);
  const [content, setContent] = useState(fact?.content ?? "");
  const [key, setKey] = useState(fact?.key ?? "");
  const [kind, setKind] = useState<MemoryFact["kind"]>(fact?.kind ?? "fact");
  const [source, setSource] = useState(fact?.source ?? "dashboard");
  const [confidence, setConfidence] = useState(String(Math.round((fact?.confidence ?? 0.5) * 100)));
  const [expiry, setExpiry] = useState(fact?.expiresAt ? "keep" : "never");
  const [pinned, setPinned] = useState(fact?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const expiresAt =
      expiry === "keep"
        ? fact?.expiresAt
        : expiry === "never"
          ? null
          : Date.now() + Number(expiry) * 86400000;
    const fields = {
      content,
      kind,
      source,
      confidence: Number(confidence) / 100,
      pinned,
      expiresAt,
    };
    try {
      await saveMemory(
        fact ? "/api/memory/facts/revise" : "/api/memory/facts",
        fact
          ? { ...fields, id: fact.id, expectedRevision: fact.revision }
          : { ...fields, entityName: entity, key: key.trim() || null },
      );
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save memory");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="memory-editor sm:max-w-2xl" showCloseButton={!busy}>
        <header>
          <div className="memory-eyebrow">
            <BookmarkPlus size={14} /> {fact ? `REVISION ${fact.revision}` : "BUILD YOUR KNOWLEDGE"}
          </div>
          <DialogTitle>{fact ? "Refine a memory" : "Remember something useful"}</DialogTitle>
          <DialogDescription>
            One reusable idea, its source, and how long it should be trusted. Never include
            passwords or private keys.
          </DialogDescription>
        </header>
        <form onSubmit={submit}>
          <ScrollArea className="memory-editor-scroll">
            <fieldset disabled={busy} className="memory-form-grid">
              <label className="memory-field">
                <span>Entity</span>
                <Input
                  required
                  maxLength={200}
                  value={entity}
                  disabled={Boolean(fact)}
                  onChange={(e) => setEntity(e.target.value)}
                  placeholder="Exact existing entity name"
                />
              </label>
              <MemorySelect
                label="Knowledge kind"
                value={kind}
                options={memoryKinds.map((value) => ({ value, label: value }))}
                onChange={(value) => setKind(value as MemoryFact["kind"])}
              />
              <label className="memory-field memory-wide">
                <span>What should the MCP remember?</span>
                <Textarea
                  dir="auto"
                  required
                  maxLength={8000}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={5}
                  placeholder="Example: Before changing the WAN route, preserve the management path."
                  className="resize-none [field-sizing:content] overflow-hidden"
                />
              </label>
              <label className="memory-field memory-wide">
                <span>Source / evidence</span>
                <Input
                  required
                  maxLength={500}
                  dir="auto"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="Operator confirmation, snapshot ID, or diagnostic reference"
                />
              </label>
              <label className="memory-field">
                <span>Stable key · optional</span>
                <Input
                  maxLength={120}
                  value={key}
                  disabled={Boolean(fact)}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="wan.provider"
                />
                <small>The same entity + key updates one fact and keeps its history.</small>
              </label>
              <label className="memory-field">
                <span>Confidence · 0–100%</span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  required
                  value={confidence}
                  onChange={(e) => setConfidence(e.target.value)}
                />
                <small>Your assessment, not an automatic accuracy score.</small>
              </label>
              <MemorySelect
                label="Expires after"
                value={expiry}
                options={[
                  ...(fact?.expiresAt ? [{ value: "keep", label: "Keep current expiry" }] : []),
                  { value: "never", label: "No expiry" },
                  { value: "1", label: "1 day" },
                  { value: "7", label: "7 days" },
                  { value: "30", label: "30 days" },
                  { value: "90", label: "90 days" },
                ]}
                onChange={setExpiry}
              />
              <label className="memory-pin-field">
                <Switch checked={pinned} onCheckedChange={setPinned} aria-label="Pin this memory" />
                <span>
                  Pin this memory<small>Prioritize it in relevant recall.</small>
                </span>
              </label>
            </fieldset>
          </ScrollArea>
          {error && (
            <p role="alert" className="memory-error">
              {error}
            </p>
          )}
          <footer className="memory-dialog-actions">
            <span>Local only · {fact ? "History preserved" : "Not yet verified"}</span>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              <Save size={15} />
              {busy ? "Saving…" : "Save memory"}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EntityEditor({
  from,
  onClose,
  onSaved,
}: {
  from?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState(from ? "depends_on" : "device");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await saveMemory<{ count: number }>(
        from ? "/api/memory/relations" : "/api/memory/entities",
        from
          ? { relations: [{ from, to: name.trim(), relationType: type.trim() }] }
          : { entities: [{ name: name.trim(), entityType: type.trim() }] },
      );
      if (!result.count)
        throw new Error(
          from
            ? "Relation exists, or the target entity does not exist."
            : "This entity already exists.",
        );
      onSaved();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{from ? "Connect this knowledge" : "Create an entity"}</DialogTitle>
        <DialogDescription>
          {from
            ? `Link ${from} to another existing entity. Relations let recall include adjacent context.`
            : "A router, network, person or reusable procedure. Creating an entity does not configure a router."}
        </DialogDescription>
        <form onSubmit={submit} className="memory-simple-form">
          <label className="memory-field">
            <span>{from ? "Target entity" : "Name"}</span>
            <Input
              autoFocus
              required
              maxLength={200}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="memory-field">
            <span>{from ? "Relation" : "Type"}</span>
            <Input
              required
              maxLength={200}
              value={type}
              disabled={busy}
              onChange={(e) => setType(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="memory-error">
              {error}
            </p>
          )}
          <Button disabled={busy} type="submit">
            <Link2 size={15} />
            {busy ? "Saving…" : from ? "Create relation" : "Create entity"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
