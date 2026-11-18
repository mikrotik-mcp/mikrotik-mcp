// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  Checkbox,
  Combobox,
  Field,
  NumberInput,
  Segmented,
  Select,
  Switch,
} from "../../ui/observability/kit";
import { choose, kitControl, kitValue, optionsOf, toggle, typeInto } from "../_stubs/kit";

vi.mock("../../ui/observability/api", () => ({ api: vi.fn(async () => ({ devices: [] })) }));
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const OPTS = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "x", label: "Locked", disabled: true },
];

test("Select shows the value, lists options, and changes on click", async () => {
  const seen: string[] = [];
  function App() {
    const [v, setV] = useState("1h");
    return h(Select, {
      value: v,
      onChange: (x: string) => {
        seen.push(x);
        setV(x);
      },
      options: OPTS,
      label: "Range",
    });
  }
  await act(async () => root.render(h(App)));
  expect(kitValue("Range")).toBe("Last hour");
  expect(await optionsOf("Range")).toEqual(["Last hour", "Last 24 hours", "Locked"]);
  await choose("Range", "Last 24 hours");
  expect(seen).toEqual(["24h"]);
  expect(kitValue("Range")).toBe("Last 24 hours");
  expect(kitControl("Range").getAttribute("aria-expanded")).toBe("false");
});

test("Select keyboard: arrows move, Enter picks, disabled options are skipped", async () => {
  function App() {
    const [v, setV] = useState("1h");
    return h(Select, { value: v, onChange: setV, options: OPTS, label: "Range" });
  }
  await act(async () => root.render(h(App)));
  const trigger = kitControl("Range");
  const key = (el: Element, k: string) =>
    act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    });
  await key(trigger, "ArrowDown");
  const list = document.querySelector('[role="listbox"]')!;
  await key(list, "ArrowDown");
  await key(list, "ArrowDown");
  await key(list, "Enter");
  expect(kitValue("Range")).toBe("Last hour");
});

test("Field links its label and error to the control", async () => {
  await act(async () =>
    root.render(
      h(Field, {
        label: "Interface",
        error: "Choose one.",
        children: h(Select, { value: "", onChange: () => {}, options: OPTS, label: "Interface" }),
      }),
    ),
  );
  const t = kitControl("Interface");
  expect(t.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(t.getAttribute("aria-describedby")!)?.textContent).toContain(
    "Choose one.",
  );
});

test("Checkbox, Switch and Segmented report changes", async () => {
  const log: string[] = [];
  function App() {
    const [c, setC] = useState(false);
    const [s, setS] = useState(false);
    const [g, setG] = useState("a");
    return h(
      "div",
      null,
      h(Checkbox, {
        checked: c,
        onCheckedChange: (x: boolean) => {
          log.push(`c${x}`);
          setC(x);
        },
        label: "Include",
      }),
      h(Switch, {
        checked: s,
        onCheckedChange: (x: boolean) => {
          log.push(`s${x}`);
          setS(x);
        },
        label: "Enabled",
      }),
      h(Segmented, {
        value: g,
        onChange: (x: string) => {
          log.push(`g${x}`);
          setG(x);
        },
        label: "View",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      }),
    );
  }
  await act(async () => root.render(h(App)));
  await toggle("Include");
  await toggle("Enabled");
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent === "B")!;
  await act(async () => b.click());
  expect(log).toEqual(["ctrue", "strue", "gb"]);
});

test("NumberInput steps, clamps and accepts typing", async () => {
  const seen: (number | null)[] = [];
  function App() {
    const [n, setN] = useState<number | null>(5);
    return h(NumberInput, {
      value: n,
      onChange: (x: number | null) => {
        seen.push(x);
        setN(x);
      },
      min: 1,
      max: 6,
      label: "Retries",
    });
  }
  await act(async () => root.render(h(App)));
  const inc = host.querySelector<HTMLButtonElement>('[aria-label="Increase Retries"]')!;
  await act(async () => inc.click());
  expect(inc.disabled).toBe(true);
  await typeInto(host.querySelector("input")!, "3");
  expect(seen).toEqual([6, 3]);
});

test("Combobox filters and allows a typed value", async () => {
  let value = "";
  function App() {
    const [v, setV] = useState("");
    value = v;
    return h(Combobox, {
      value: v,
      onChange: setV,
      label: "Interface",
      options: ["ether1", "ether2", "wlan1"].map((x) => ({ value: x, label: x })),
    });
  }
  await act(async () => root.render(h(App)));
  await typeInto(kitControl("Interface") as HTMLInputElement, "eth");
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
    "ether1",
    "ether2",
    "Use “eth” as typed",
  ]);
  await act(async () => (document.querySelector('[role="option"]') as HTMLElement).click());
  expect(value).toBe("ether1");
});
