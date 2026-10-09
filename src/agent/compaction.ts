/**
 * Keeping a conversation under a token limit. Each provider keeps its own
 * message format, so the provider sessions do the summarizing; these are
 * the shared pieces: which turns to fold, what to ask the model, and a
 * token estimate for when the provider has not reported one.
 */

/** Tokens a screenshot or pasted image costs, roughly, whatever its byte size. */
export const imageTokens = 1600;

/**
 * Split messages into the oldest `fraction` of turns and the rest. A turn
 * starts at a message `isTurnStart` accepts (a real user prompt, not a tool
 * result). At least one turn is folded and at least one is kept; with fewer
 * than two turns there is nothing to do.
 */
export function splitOldestTurns<T>(
  messages: T[],
  isTurnStart: (message: T) => boolean,
  fraction: number,
): { folded: T[]; kept: T[]; turns: number } | null {
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (isTurnStart(message)) starts.push(index);
  });
  if (starts.length < 2) return null;
  const count = Math.min(starts.length - 1, Math.max(1, Math.floor(starts.length * fraction)));
  const cut = starts[count] ?? messages.length;
  return { folded: messages.slice(0, cut), kept: messages.slice(cut), turns: count };
}

export const summaryInstructions = `You are compacting the earlier part of a coding session between a user and an agent working in a sandboxed project. Write a summary the agent can continue from without the original messages. Include, in this order: the user's goal and any constraints they stated; what was built or changed, naming files and commands precisely; decisions and why; problems hit and how they were fixed or left; what the user last asked for and what remains open. Keep facts exact (names, paths, ports, URLs, versions); drop pleasantries, repeated tool output and anything superseded. Plain prose and short lists, under 700 words. Do not address the user; this text is for the agent.`;

/** The message that stands in for the folded turns. */
export function summaryMessage(summary: string) {
  return `[Earlier in this session, compacted by Sparkbox to stay within the context limit. The agent's own summary of that part:]\n\n${summary.trim()}`;
}

export const summaryAcknowledgement = "Understood. I'll continue from that state.";

/** Trim a tool result or long text for the summarizer's input. */
export function excerpt(text: string, limit = 1500) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  return `${text.slice(0, head)}\n…[${text.length - limit} characters omitted]…\n${text.slice(-(limit - head))}`;
}

/** A rough token count for serialized messages: text at four characters per token, images flat. */
export function estimateTokens(text: string, images: number) {
  return Math.ceil(text.length / 4) + images * imageTokens;
}

export type Compaction = { turns: number; promptTokens: number };

export function compactionNotice(result: Compaction, limit: number) {
  return `Compacted the oldest ${result.turns} ${result.turns === 1 ? "turn" : "turns"} into a summary: the last prompt was about ${result.promptTokens.toLocaleString()} tokens, over this deployment's ${limit.toLocaleString()}-token limit.`;
}
