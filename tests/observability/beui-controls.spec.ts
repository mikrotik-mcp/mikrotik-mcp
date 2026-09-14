// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { act, createElement as h, createRef } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { Button } from "../../ui/observability/components/ui/button";
import { Input } from "../../ui/observability/components/ui/input";
import { Checkbox } from "../../ui/observability/components/ui/checkbox";
import { Switch } from "../../ui/observability/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../ui/observability/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../ui/observability/components/ui/tabs";
import { OperationsIsland } from "../../ui/observability/operations-island";
import { DashboardRefresh } from "../../ui/observability/dashboard-refresh";
import { FeedActions } from "../../ui/observability/feed-actions";
import { DashboardSidebar } from "../../ui/observability/dashboard-shell";
import {
  AnimatedSidebarProvider,
  AnimatedSidebarTrigger,
} from "../../ui/observability/components/beui/registry/components/motion/animated-sidebar";
import { PullToRefresh } from "../../ui/observability/components/beui/registry/components/motion/pull-to-refresh";

// Happy DOM's partial WAAPI rejects cancelled animations. Exercise Motion's JS
// fallback here; real rendering and animation are checked in the browser.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

let host: HTMLDivElement;
let root: Root;
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
const render = async (node: ReactNode) => {
  await act(async () => root.render(node));
};
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
const key = async (element: HTMLElement, key: string) => {
  await act(async () =>
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
  );
};

test("BeUI buttons retain native submission, disabled behavior and button refs", async () => {
  const submit = vi.fn((event: Event) => event.preventDefault());
  const activate = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  await render(
    h(
      "form",
      { onSubmit: submit },
      h(Button, { ref, type: "submit", onClick: activate }, "Save"),
      h(Button, { disabled: true, onClick: activate }, "Disabled"),
    ),
  );
  await click(ref.current!);
  expect(activate).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
  await click(host.querySelector<HTMLButtonElement>("button:disabled")!);
  expect(activate).toHaveBeenCalledTimes(1);
});

test("input forwards native constraints, focus, controlled values and refs", async () => {
  const ref = createRef<HTMLInputElement>();
  const focus = vi.fn();
  await render(
    h(Input, {
      ref,
      type: "number",
      value: 2000,
      min: 1,
      max: 10000,
      required: true,
      disabled: true,
      onFocus: focus,
      onChange: vi.fn(),
      "aria-label": "Maximum latency",
    }),
  );
  expect(ref.current?.value).toBe("2000");
  expect(ref.current?.min).toBe("1");
  expect(ref.current?.required).toBe(true);
  expect(ref.current?.disabled).toBe(true);
  expect(ref.current?.className).toContain("text-[13px]");
  expect(ref.current?.className).not.toContain("text-base");
  await render(h(Input, { ref, value: "new", onChange: vi.fn(), onFocus: focus }));
  await act(async () => ref.current?.focus());
  expect(ref.current?.value).toBe("new");
  expect(document.activeElement).toBe(ref.current);
  expect(focus).toHaveBeenCalledOnce();
});

test("checkbox preserves mixed state, pointer metadata, explicit labels and callbacks", async () => {
  const change = vi.fn();
  const pointer = vi.fn();
  await render(
    h(
      "label",
      { htmlFor: "row" },
      "Select row",
      h(Checkbox, {
        id: "row",
        checked: "indeterminate",
        onCheckedChange: change,
        onPointerDown: pointer,
      }),
    ),
  );
  const checkbox = host.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
  expect(host.querySelectorAll("label")).toHaveLength(1);
  await act(async () =>
    checkbox.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, shiftKey: true })),
  );
  expect(pointer.mock.calls[0]?.[0].shiftKey).toBe(true);
  await click(checkbox);
  expect(change).toHaveBeenCalledWith(true);
  await render(h(Checkbox, { disabled: true, checked: false, onCheckedChange: change }));
  await click(host.querySelector<HTMLButtonElement>('[role="checkbox"]')!);
  expect(change).toHaveBeenCalledTimes(1);
});

test("input exposes the real native change event, including its input target", async () => {
  const changed = vi.fn();
  await render(h(Input, { defaultValue: "old", onChange: changed }));
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "new value",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0]?.[0].target).toBe(input);
  expect(input.value).toBe("new value");
});

test("switch keeps controlled state, labels and disabled protection", async () => {
  const change = vi.fn();
  await render(
    h(Switch, { checked: false, onCheckedChange: change, id: "enabled", "aria-label": "Enabled" }),
  );
  const control = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(control.id).toBe("enabled");
  expect(control.getAttribute("aria-label")).toBe("Enabled");
  await click(control);
  expect(change).toHaveBeenCalledWith(true);
  expect(control.getAttribute("aria-checked")).toBe("false");
  await render(h(Switch, { checked: true, disabled: true, onCheckedChange: change }));
  await click(control);
  expect(change).toHaveBeenCalledTimes(1);
});

function selector(change = vi.fn()) {
  return h(Select, {
    defaultValue: "home",
    onValueChange: change,
    children: [
      h(SelectTrigger, {
        key: "trigger",
        id: "router",
        "aria-label": "Router",
        children: h(SelectValue, { placeholder: "Select a router" }),
      }),
      h(SelectContent, {
        key: "content",
        children: [
          h(SelectItem, { key: "a", value: "home", children: h("span", null, "Home router") }),
          h(SelectItem, { key: "b", value: "disabled", disabled: true, children: "Unavailable" }),
          h(SelectItem, { key: "c", value: "remote", children: "Remote router" }),
        ],
      }),
    ],
  });
}

test("BeUI Select labels survive close; keyboard skips disabled options and restores focus", async () => {
  const change = vi.fn();
  await render(selector(change));
  const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  expect(trigger.textContent).toContain("Home router");
  await key(trigger, "ArrowDown");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement?.textContent).toContain("Home router");
  await key(document.activeElement as HTMLElement, "ArrowDown");
  expect(document.activeElement?.textContent).toBe("Remote router");
  await click(document.activeElement as HTMLElement);
  expect(change).toHaveBeenCalledWith("remote");
  expect(trigger.textContent).toContain("Remote router");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  await click(trigger);
  await key(document.activeElement as HTMLElement, "Escape");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

test("Select options stay inside the containing dialog's focus scope", async () => {
  await render(h("div", { role: "dialog" }, selector()));
  const dialog = host.querySelector('[role="dialog"]')!;
  const trigger = dialog.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  await click(trigger);
  expect(dialog.contains(document.querySelector('[role="listbox"]'))).toBe(true);
  expect(dialog.contains(document.activeElement)).toBe(true);
});

test("Select menu fits option labels instead of the narrow trigger and stays in the viewport", async () => {
  await render(selector());
  const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  const menu = document.querySelector<HTMLDivElement>('[role="listbox"]')!;
  const list = menu.firstElementChild as HTMLDivElement;
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(
    new DOMRect(window.innerWidth - 120, 80, 100, 32),
  );
  vi.spyOn(list, "offsetWidth", "get").mockReturnValue(340);
  await click(trigger);
  expect(Number.parseFloat(menu.style.width)).toBe(342);
  expect(
    Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width),
  ).toBeLessThanOrEqual(window.innerWidth - 8);
  expect(list.style.minWidth).toBe("100px");
  await key(document.activeElement as HTMLElement, "Escape");
  Object.defineProperty(list, "offsetWidth", { configurable: true, value: 4000 });
  await click(trigger);
  expect(Number.parseFloat(menu.style.width)).toBe(window.innerWidth - 16);
  expect(Number.parseFloat(menu.style.left)).toBe(8);
});

test("unknown controlled router values never select the first router silently", async () => {
  const change = vi.fn();
  await render(
    h(Select, {
      value: "deleted-router",
      onValueChange: change,
      children: [
        h(SelectTrigger, {
          key: "trigger",
          children: h(SelectValue, { placeholder: "Select a router" }),
        }),
        h(SelectContent, {
          key: "content",
          children: h(SelectItem, { value: "home", children: "Home" }),
        }),
      ],
    }),
  );
  expect(host.textContent).toContain("Select a router");
  expect(change).not.toHaveBeenCalled();
});

test("tabs do not mount inactive operational panels and support arrow navigation", async () => {
  const mounted = vi.fn();
  function Inactive() {
    mounted();
    return h("p", null, "Remote panel");
  }
  await render(
    h(Tabs, {
      defaultValue: "local",
      children: [
        h(TabsList, { key: "list" }, [
          h(TabsTrigger, { key: "local", value: "local", children: "Local" }),
          h(TabsTrigger, { key: "remote", value: "remote", children: "Remote" }),
        ]),
        h(TabsContent, { key: "local", value: "local", children: "Local panel" }),
        h(TabsContent, { key: "remote", value: "remote", children: h(Inactive) }),
      ],
    }),
  );
  expect(mounted).not.toHaveBeenCalled();
  const trigger = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
  await act(async () => trigger.focus());
  await key(trigger, "ArrowRight");
  expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
  expect(host.querySelector('[role="tabpanel"]')?.textContent).toBe("Remote panel");
});

test("Operations Island expands, switches views and closes without issuing requests", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await render(
    h(OperationsIsland, {
      mode: "off",
      paused: false,
      liveEvent: null,
      liveEventAt: null,
      events: [],
      stats: null,
      statsAt: null,
      devices: null,
      pool: null,
      poolAt: null,
      alerts: null,
      alertsAt: null,
      onNavigate: vi.fn(),
      onEvent: vi.fn(),
    }),
  );
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="Open Operations Island"]')!;
  expect(host.querySelector('[data-anchor="bottom"]')?.className).toContain("items-end");
  expect(trigger.textContent).toContain("Stream offline");
  await click(trigger);
  expect(host.querySelector("#operations-island-panel")).not.toBeNull();
  const routers = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (tab) => tab.textContent === "Routers",
  )!;
  await click(routers);
  expect(host.textContent).toContain("No healthy state is assumed");
  await key(routers, "Escape");
  expect(document.activeElement?.getAttribute("aria-label")).toContain("Open Operations Island");
  await click(host.querySelector<HTMLButtonElement>('[aria-label^="Open Operations Island"]')!);
  await click(host.querySelector<HTMLButtonElement>('[aria-label="Collapse Operations Island"]')!);
  expect(document.activeElement?.getAttribute("aria-label")).toContain("Open Operations Island");
  expect(fetch).not.toHaveBeenCalled();
});

test("refresh keeps content mounted, locks duplicate requests, and reports failures", async () => {
  let finish!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render(
    h(DashboardRefresh, {
      enabled: true,
      onRefresh: refresh,
      children: h("input", { defaultValue: "keep my filter" }),
    }),
  );
  const input = host.querySelector("input");
  const button = host.querySelector<HTMLButtonElement>("button")!;
  await click(button);
  await click(button);
  expect(refresh).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(true);
  await act(async () => finish());
  expect(host.querySelector("input")).toBe(input);
  expect(input?.value).toBe("keep my filter");
  expect(host.textContent).toContain("Dashboard data refreshed");
  await render(
    h(DashboardRefresh, {
      enabled: true,
      onRefresh: async () => {
        throw new Error("offline");
      },
      children: "Saved data",
    }),
  );
  await click(host.querySelector<HTMLButtonElement>("button")!);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Previous data kept");
});

test("pull gestures require the handle, ignore cancelled pulls and refresh once on release", async () => {
  const refresh = vi.fn();
  await render(
    h(PullToRefresh, {
      handleOnly: true,
      onRefresh: refresh,
      children: [
        h("div", { key: "handle", "data-refresh-handle": true }, "Pull here"),
        h("button", { key: "button", type: "button" }, "Action"),
      ],
    }),
  );
  const section = host.querySelector("section")!;
  const handle = host.querySelector<HTMLElement>("[data-refresh-handle]")!;
  const pointer = async (target: HTMLElement, type: string, y: number) => {
    await act(async () => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          clientX: 10,
          clientY: y,
        }),
      );
    });
  };
  await pointer(host.querySelector("button")!, "pointerdown", 0);
  await pointer(section, "pointermove", 300);
  await pointer(section, "pointerup", 300);
  expect(refresh).not.toHaveBeenCalled();
  await pointer(handle, "pointerdown", 0);
  await pointer(section, "pointermove", 300);
  await pointer(section, "pointercancel", 300);
  expect(refresh).not.toHaveBeenCalled();
  await pointer(handle, "pointerdown", 0);
  await pointer(section, "pointermove", 300);
  await pointer(section, "pointerup", 300);
  expect(refresh).toHaveBeenCalledOnce();
});

test("expandable feed actions never delete on reveal, and disabled selection stays protected", async () => {
  const remove = vi.fn();
  const pause = vi.fn();
  const props = {
    paused: false,
    count: 0,
    onPause: pause,
    onExport: vi.fn(),
    onClear: vi.fn(),
    onDelete: remove,
  };
  await render(h(FeedActions, props));
  const deleteButton = host.querySelector<HTMLButtonElement>('[aria-label="Delete selected"]')!;
  await click(deleteButton);
  expect(remove).not.toHaveBeenCalled();
  await render(h(FeedActions, { ...props, count: 2 }));
  const enabled = host.querySelector<HTMLButtonElement>('[aria-label="Delete selected"]')!;
  await act(async () => enabled.focus());
  expect(remove).not.toHaveBeenCalled();
  await click(enabled);
  expect(remove).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(enabled);
});

test("animated sidebar retains navigation, pins and modified-link behavior when collapsed", async () => {
  const navigate = vi.fn();
  await render(
    h(AnimatedSidebarProvider, {
      children: [
        h(AnimatedSidebarTrigger, { key: "toggle", "aria-label": "Toggle navigation" }),
        h(DashboardSidebar, {
          key: "sidebar",
          view: "feed",
          onNavigate: navigate,
          renderIcon: () => h("span", null, "•"),
          onMobileOpenChange: vi.fn(),
          liveMode: "off",
          feedCount: 0,
          firingCount: 0,
          releaseAvailable: false,
          controls: null,
        }),
      ],
    }),
  );
  await click(host.querySelector<HTMLButtonElement>('[aria-label="Toggle navigation"]')!);
  expect(host.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("collapsed");
  const link = host.querySelector<HTMLAnchorElement>('a[href="#devices"]')!;
  expect(link.getAttribute("aria-label")).toBe("Devices");
  expect(link.title).toBe("Devices");
  expect(link.querySelector('[data-slot="sidebar-menu-label"]')?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  await act(async () =>
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })),
  );
  expect(navigate).not.toHaveBeenCalled();
  await click(link);
  expect(navigate).toHaveBeenCalledWith("devices");
  await click(host.querySelector<HTMLButtonElement>('[aria-label="Toggle navigation"]')!);
  expect(link.querySelector('[data-slot="sidebar-menu-label"]')?.getAttribute("aria-hidden")).toBe(
    "false",
  );
  expect(
    host.querySelector('[aria-label="Pin Devices"], [aria-label="Unpin Devices"]'),
  ).not.toBeNull();
});
