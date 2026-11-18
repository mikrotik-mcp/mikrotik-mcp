/**
 * Test helpers for the Signal UI kit (ui/observability/kit). Kit controls are
 * not native elements, so tests drive them the way a user does: open the
 * select, click the option. Call these inside a happy-dom test.
 */
import { act } from "react";

const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const test = (s: string, want: string | RegExp): boolean =>
  typeof want === "string" ? s === want || s.includes(want) : want.test(s);

function nameOf(el: HTMLElement): string {
  const own = el.getAttribute("aria-label");
  if (own) return own;
  const by = el.getAttribute("aria-labelledby");
  if (by) return text(document.getElementById(by));
  if (el.id) return text(document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
  return "";
}

/** The kit Select / RouterPicker / Combobox trigger whose accessible name matches. */
export function kitControl(name: string | RegExp, root: ParentNode = document): HTMLElement {
  const all = [...root.querySelectorAll<HTMLElement>('[role="combobox"]')];
  const hit = all.find((el) => test(nameOf(el), name));
  if (!hit)
    throw new Error(`No kit control named ${String(name)}; found: ${all.map(nameOf).join(", ")}`);
  return hit;
}

/** The value shown on a kit Select trigger. */
export function kitValue(name: string | RegExp, root: ParentNode = document): string {
  return text(kitControl(name, root).querySelector(".v"));
}

/** Opens the kit select named `name` and clicks the option whose text matches. */
export async function choose(
  name: string | RegExp,
  option: string | RegExp,
  root: ParentNode = document,
): Promise<void> {
  const trigger = kitControl(name, root);
  await act(async () => trigger.click());
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const hit = options.find((o) => test(text(o), option));
  if (!hit)
    throw new Error(
      `No option ${String(option)} in ${String(name)}; found: ${options.map(text).join(" | ")}`,
    );
  await act(async () => hit.click());
}

/** The options a kit select lists, after opening it. Closes it again. */
export async function optionsOf(
  name: string | RegExp,
  root: ParentNode = document,
): Promise<string[]> {
  const trigger = kitControl(name, root);
  await act(async () => trigger.click());
  const list = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(text);
  await act(async () => trigger.click());
  return list;
}

/** A kit Checkbox or Switch by its label text or aria-label. */
export function kitToggle(name: string | RegExp, root: ParentNode = document): HTMLButtonElement {
  const all = [...root.querySelectorAll<HTMLButtonElement>('[role="checkbox"], [role="switch"]')];
  const hit = all.find((el) => {
    const label =
      el.closest("label") ??
      (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
    return test(el.getAttribute("aria-label") ?? text(label), name);
  });
  if (!hit) throw new Error(`No kit checkbox or switch named ${String(name)}`);
  return hit;
}

export async function toggle(name: string | RegExp, root: ParentNode = document): Promise<void> {
  const el = kitToggle(name, root);
  await act(async () => el.click());
}

/** Types into a native input or textarea inside a kit field, so React sees it. */
export async function typeInto(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
