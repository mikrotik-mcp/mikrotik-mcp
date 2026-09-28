import { useEffect, useState } from "react";
import {
  Action,
  ActionPanel,
  AI,
  Clipboard,
  Color,
  Detail,
  environment,
  Form,
  Icon,
  List,
  open,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import {
  composePrompt,
  missingPromptArguments,
  promptCategory,
} from "../../src/prompts/compose";
import type { PromptTemplate } from "../../src/prompts/compose";
import { useApi } from "./lib/hooks";

/** A native request builder; browsing and composing never contact an AI or router. */
export default function PromptsCommand() {
  const { data, isLoading, error, revalidate } = useApi<{
    prompts: PromptTemplate[];
  }>("/api/catalog");
  const [category, setCategory] = useState("All workflows");
  const prompts = data?.prompts ?? [];
  const categories = [...new Set(prompts.map(promptCategory))].sort();
  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      searchBarPlaceholder="Find a workflow for your next request…"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Workflow category"
          value={category}
          onChange={setCategory}
        >
          <List.Dropdown.Item title="All workflows" value="All workflows" />
          {categories.map((value) => (
            <List.Dropdown.Item key={value} title={value} value={value} />
          ))}
        </List.Dropdown>
      }
    >
      {categories
        .filter((value) => category === "All workflows" || value === category)
        .map((group) => (
          <List.Section key={group} title={group}>
            {prompts
              .filter((p) => promptCategory(p) === group)
              .map((prompt) => (
                <List.Item
                  key={prompt.name}
                  title={prompt.title}
                  keywords={[prompt.name, prompt.description]}
                  icon={{ source: Icon.Message, tintColor: Color.Blue }}
                  accessories={[
                    {
                      text: `${prompt.arguments.filter((a) => a.required).length} required`,
                      tooltip: "Required inputs",
                    },
                  ]}
                  detail={
                    <List.Item.Detail
                      markdown={`# ${prompt.title}\n\n${prompt.description}\n\n---\n\n${prompt.body}`}
                      metadata={
                        <List.Item.Detail.Metadata>
                          <List.Item.Detail.Metadata.Label
                            title="Workflow"
                            text={prompt.name}
                          />
                          <List.Item.Detail.Metadata.Label
                            title="Category"
                            text={group}
                          />
                          <List.Item.Detail.Metadata.Separator />
                          {prompt.arguments.map((a) => (
                            <List.Item.Detail.Metadata.Label
                              key={a.name}
                              title={a.name}
                              text={a.required ? "Required" : "Optional"}
                            />
                          ))}
                        </List.Item.Detail.Metadata>
                      }
                    />
                  }
                  actions={
                    <ActionPanel>
                      <Action.Push
                        title="Compose Request"
                        icon={Icon.Pencil}
                        target={<PromptForm prompt={prompt} />}
                      />
                      <Action
                        title="Refresh Library"
                        icon={Icon.ArrowClockwise}
                        onAction={() => void revalidate()}
                      />
                    </ActionPanel>
                  }
                />
              ))}
          </List.Section>
        ))}
      <List.EmptyView
        icon={error ? Icon.ExclamationMark : Icon.MagnifyingGlass}
        title={
          error
            ? "Cannot load workflows"
            : isLoading
              ? "Loading workflows…"
              : "No matching workflows"
        }
        description={
          error
            ? "Check the dashboard URL and access token in extension preferences."
            : "Try another search or category."
        }
        actions={
          <ActionPanel>
            <Action title="Retry" onAction={() => void revalidate()} />
          </ActionPanel>
        }
      />
    </List>
  );
}

export function PromptForm({ prompt }: { prompt: PromptTemplate }) {
  const { push } = useNavigation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [request, setRequest] = useState("");
  const [device, setDevice] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const missing = missingPromptArguments(prompt, values);
  function preview() {
    setSubmitted(true);
    if (missing.length) return;
    push(
      <PromptPreview
        title={prompt.title}
        text={composePrompt(prompt, values, request, device)}
      />,
    );
  }
  return (
    <Form
      navigationTitle={prompt.title}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Preview Request"
            icon={Icon.Eye}
            onSubmit={preview}
          />
        </ActionPanel>
      }
    >
      <Form.Description title="Workflow" text={prompt.description} />
      <Form.TextArea
        id="request"
        title="Your Request"
        placeholder="What outcome do you want? Add symptoms and constraints."
        value={request}
        onChange={setRequest}
      />
      <Form.TextField
        id="device"
        title="Target Router"
        placeholder="Configured MCP name; leave blank to ask first"
        value={device}
        onChange={setDevice}
      />
      <Form.Separator />
      {prompt.arguments.map((arg) => (
        <Form.TextField
          key={arg.name}
          id={`arg:${arg.name}`}
          title={`${arg.name}${arg.required ? " *" : ""}`}
          info={arg.description}
          value={values[arg.name] ?? ""}
          onChange={(value) => setValues({ ...values, [arg.name]: value })}
          error={
            submitted && missing.includes(arg.name) ? "Required" : undefined
          }
        />
      ))}
      <Form.Separator />
      <Form.Description
        title="Private draft"
        text="Nothing runs while you prepare this request. Review it before sharing. Drafts are not saved."
      />
    </Form>
  );
}

function PromptPreview({ title, text }: { title: string; text: string }) {
  const { push } = useNavigation();
  async function handoff(url: string) {
    try {
      await Clipboard.copy(text);
      await open(url);
      await showToast({
        style: Toast.Style.Success,
        title: "Request copied",
        message: "Paste it into your MCP-connected assistant.",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not open assistant",
        message: String(error),
      });
    }
  }
  return (
    <Detail
      navigationTitle="Review your request"
      markdown={text}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Workflow" text={title} />
          <Detail.Metadata.Label
            title="Status"
            text="Draft · nothing executed"
          />
          <Detail.Metadata.Label
            title="Length"
            text={`${text.length.toLocaleString()} characters`}
          />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="Raycast AI"
            text={
              environment.canAccess(AI)
                ? "Advice only · no MCP tools"
                : "Requires Raycast AI access"
            }
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Use with your MCP-connected assistant">
            <Action.CopyToClipboard title="Copy Request" content={text} />
            <Action.Paste
              title="Paste Request into Active App"
              content={text}
            />
            <Action
              title="Copy and Open ChatGPT"
              icon={Icon.Message}
              onAction={() => handoff("https://chatgpt.com/")}
            />
            <Action
              title="Copy and Open Claude"
              icon={Icon.Message}
              onAction={() => handoff("https://claude.ai/new")}
            />
          </ActionPanel.Section>
          {environment.canAccess(AI) && (
            <ActionPanel.Section title="Sends this request to Raycast AI · advice only">
              <Action
                title="Ask Raycast AI for a Plan"
                icon={Icon.Stars}
                onAction={() => push(<PromptAnswer text={text} />)}
              />
            </ActionPanel.Section>
          )}
        </ActionPanel>
      }
    />
  );
}

function PromptAnswer({ text }: { text: string }) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    AI.ask(
      `You have no MikroTik MCP connection or tools in this chat. Provide advice and a proposed plan only. Never claim to have inspected or changed a router.\n\n${text}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setAnswer(result);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [text]);
  return (
    <Detail
      navigationTitle="Raycast AI · advice only"
      isLoading={loading}
      markdown={`> Planning assistance only. No router was inspected or changed.\n\n${error ? `Could not generate a plan: ${error}` : answer || "Preparing your plan…"}`}
      actions={
        <ActionPanel>
          {answer && (
            <Action.CopyToClipboard title="Copy Answer" content={answer} />
          )}
          <Action.CopyToClipboard
            title="Copy Original Request"
            content={text}
          />
        </ActionPanel>
      }
    />
  );
}
