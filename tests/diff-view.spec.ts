// @vitest-environment happy-dom
import { describe, expect, test } from "vite-plus/test";
import { diffElement, diffKind, isUnifiedDiff } from "../ui/shared/diff";

describe("shared GitHub diff rendering", () => {
  test("distinguishes headers from changed content", () => {
    expect(diffKind("--- before.rsc")).toBe("file");
    expect(diffKind("+++ after.rsc")).toBe("file");
    expect(diffKind("---value")).toBe("del");
    expect(diffKind("+enabled=yes")).toBe("add");
    expect(diffKind("@@ -1 +1 @@")).toBe("hunk");
    expect(diffKind(" context")).toBe("ctx");
  });
  test("detects real diffs without mistaking prose for a diff", () => {
    expect(isUnifiedDiff("Report\n--- old\n+++ new\n@@ -1 +1 @@\n-a\n+b")).toBe(true);
    expect(isUnifiedDiff("- an ordinary bullet\n+1 count")).toBe(false);
  });
  test("preserves signs, blank lines, whitespace and escapes untrusted text", () => {
    const input =
      "--- old\r\n+++ new\r\n@@ -1 +1 @@\r\n-  old\r\n+<img src=x onerror=alert(1)>\r\n context\r\n";
    const node = diffElement(input);
    expect(
      Array.from(node.children)
        .map((el) => el.textContent)
        .join("\n"),
    ).toBe(input.replace(/\r\n/g, "\n"));
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelectorAll(".diff-file")).toHaveLength(2);
    expect(node.querySelectorAll(".diff-add")).toHaveLength(1);
    expect(node.querySelectorAll(".diff-del")).toHaveLength(1);
    expect(node.tabIndex).toBe(0);
  });
});
