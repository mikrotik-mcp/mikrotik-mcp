import { expect, test } from "vite-plus/test";
import { listPrompts } from "../src/prompts";
import { composePrompt, missingPromptArguments, substitutePrompt } from "../src/prompts/compose";

test("every shipped workflow composes into a complete, explicitly bounded request", () => {
  const prompts = listPrompts();
  expect(prompts.length).toBeGreaterThan(0);
  for (const prompt of prompts) {
    const values = Object.fromEntries(
      prompt.arguments
        .filter((arg) => arg.required)
        .map((arg) => [arg.name, `example-${arg.name}`]),
    );
    const text = composePrompt(
      prompt,
      values,
      "Investigate without changing configuration",
      "home-router",
    );
    expect(text).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    expect(text).toContain("Target device (configured MCP name): home-router");
    expect(text).toContain("Investigate without changing configuration");
    expect(text).toContain("Never invent observations");
    expect(text).toContain("take a recoverable backup first");
  }
});

test("required inputs fail closed and substitution preserves literal user text", () => {
  const prompt = {
    name: "test",
    title: "Test",
    description: "",
    arguments: [{ name: "target", required: true }, { name: "constructor" }],
    body: "Check {{target}}. Context: {{constructor}}.",
  };
  expect(missingPromptArguments(prompt, { target: "  " })).toEqual(["target"]);
  expect(() => composePrompt(prompt, {})).toThrow("Complete required fields: target");
  const text = composePrompt(prompt, { target: "$&\n{{other}}" });
  expect(text).toContain("Check $&\n{{other}}");
  expect(text).toContain("Context: (not specified; ask if needed)");
  expect(text).toContain("Confirm the target router");
  expect(
    substitutePrompt("{{constructor}} {{x}} {{y}} {{z}}", { x: 0, y: false, z: { value: 1 } }),
  ).toBe('{{constructor}} 0 false {"value":1}');
  expect(substitutePrompt("{{x}}", { x: "" })).toBe("{{x}}");
});
