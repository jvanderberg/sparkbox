// User/assistant row layout adapted from T3 Code MessagesTimeline.tsx (MIT; vendor/t3code/LICENSE.txt).

import { FileCode2, Terminal, Wrench } from "lucide-react";
import { Fragment } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentImages } from "./AgentImages.tsx";
import type { AgentEvent, QueuedPrompt } from "./agents/protocol.ts";
import { MarkdownCodeBlock } from "./vendor/t3code/MarkdownCodeBlock.tsx";
import { MessageCopyButton } from "./vendor/t3code/MessageCopyButton.tsx";
import { QueuedMessageRow } from "./vendor/t3code/QueuedMessageRow.tsx";
import { SimpleWorkEntryRow } from "./vendor/t3code/SimpleWorkEntryRow.tsx";
import { ThinkingIndicator, WorkingIndicator } from "./vendor/t3code/WorkingIndicator.tsx";
import "./vendor/t3code/markdown.css";

// The SDK payload is transport data, not the visible tool result. This mirrors
// upstream buildToolCallExpandedBody: command/detail/output, with duplicates removed.
function toolFailed(event: AgentEvent) {
  try {
    return ["error", "failed"].includes(JSON.parse(event.details ?? "{}").status);
  } catch {
    return false;
  }
}

function ToolActivity({ event, active }: { event: AgentEvent; active: boolean }) {
  let detail = "";
  let status = "";
  let body = event.details || event.text;
  try {
    const data = JSON.parse(event.details ?? "{}");
    const input = data.input ?? data;
    detail =
      input.filePath ?? input.file_path ?? input.path ?? input.command ?? input.description ?? "";
    status = data.status ?? "";
    const blocks = [
      input.command,
      input.description,
      data.output,
      data.error,
      input.content,
      input.old_string,
      input.new_string,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    body = [...new Set(blocks)].join("\n\n") || detail || event.text;
  } catch {
    // Older runtime events can contain a plain text result.
  }
  const command = /bash|terminal|shell|run_command/i.test(event.text);
  const file = /read|edit|write|patch/i.test(event.text);
  const Icon = command ? Terminal : file ? FileCode2 : Wrench;
  const verb = /read/i.test(event.text)
    ? "Read"
    : /edit|write|patch/i.test(event.text)
      ? "Edit"
      : command
        ? "Run"
        : event.text;
  return (
    <SimpleWorkEntryRow
      label={`${verb} ${detail}`.trim()}
      body={body}
      failed={status === "error"}
      active={active}
      icon={<Icon className="size-4 shrink-0 stroke-[1.8]" />}
    />
  );
}

export function AgentTimeline({
  events,
  onOpenFile,
  working,
  workingStartedAt,
  awaitingInput,
  queued,
  onSendQueuedNow,
  onCancelQueued,
}: {
  events: AgentEvent[];
  working: boolean;
  workingStartedAt?: string;
  awaitingInput: boolean;
  onOpenFile: (path: string) => void;
  /** Messages waiting for the running turn, oldest first. */
  queued: QueuedPrompt[];
  onSendQueuedNow: (id: string) => void;
  onCancelQueued: (id: string) => void;
}) {
  const timeline = events.filter((event) => ["user", "text", "tool"].includes(event.type));
  const activeStart = timeline.findLastIndex((event) => event.type === "user") + 1;
  const latest = timeline.at(-1);
  // Upstream keeps the latest successful tool label alive until the next
  // assistant message. A failure returns to Thinking; old turns never animate.
  const activeToolId =
    working &&
    !awaitingInput &&
    timeline.length > activeStart &&
    latest?.type === "tool" &&
    !toolFailed(latest)
      ? latest.id
      : undefined;
  const rows = timeline.map((event, index) => {
    if (event.type === "tool")
      return <ToolActivity key={event.id} event={event} active={event.id === activeToolId} />;
    if (event.type === "user")
      return (
        <article className="chat-user group flex flex-col items-end gap-1" key={event.id}>
          <span className="sr-only">You</span>
          {!!event.images?.length && <AgentImages images={event.images} />}
          {event.text && (
            <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
              {event.text}
            </div>
          )}
          {event.text && (
            <div className="t3-user-meta flex w-full max-w-[80%] items-center justify-end pe-1 text-xs opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
              <MessageCopyButton text={event.text} label="Copy your message" />
            </div>
          )}
        </article>
      );
    if (event.type !== "text") return null;
    return (
      <article
        className="chat-assistant group/assistant relative min-w-0 px-1 py-0.5"
        key={event.id}
      >
        <span className="sr-only">Agent</span>
        <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              pre: MarkdownCodeBlock,
              img: ({ alt }) => <span>{alt ? `Image: ${alt}` : "Image"}</span>,
              a: ({ href, children }) => {
                const file = href && !/^[a-z][a-z\d+.-]*:|^\/\/|^#/i.test(href);
                return file ? (
                  <button
                    className="chat-file-link"
                    type="button"
                    onClick={() => onOpenFile(href.replace(/^\.\//, ""))}
                  >
                    {children}
                  </button>
                ) : (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                );
              },
            }}
          >
            {event.text}
          </Markdown>
        </div>
        {(index === timeline.length - 1 ? !working : timeline[index + 1]?.type === "user") && (
          <div className="t3-assistant-meta mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100">
            <MessageCopyButton text={event.text} label="Copy response" />
          </div>
        )}
      </article>
    );
  });
  return (
    <>
      {rows.map((row, index) => (
        <Fragment key={timeline[index]?.id}>
          {working && index === activeStart && <WorkingIndicator startedAt={workingStartedAt} />}
          {row}
        </Fragment>
      ))}
      {working && activeStart === rows.length && <WorkingIndicator startedAt={workingStartedAt} />}
      {working && !awaitingInput && !activeToolId && <ThinkingIndicator />}
      {queued.map((message, index) => (
        <QueuedMessageRow
          key={message.id}
          message={message}
          isNext={index === 0}
          onSendNow={() => onSendQueuedNow(message.id)}
          onCancel={() => onCancelQueued(message.id)}
        />
      ))}
    </>
  );
}
