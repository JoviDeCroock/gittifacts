/**
 * The agent's conversation in OpenAI chat-completions shape, plus the two size controls:
 * `truncate` for a single tool result and `compact` for the whole history.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as the model produced them (parsed by the loop). */
  arguments: string;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function assistantMessage(content: string | null, calls: readonly ToolCall[]): Message {
  if (calls.length === 0) return { role: "assistant", content: content ?? "" };
  return {
    role: "assistant",
    content,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    })),
  };
}

/**
 * Keeps the head and the tail of `text` within `max` characters (errors and summaries tend to sit
 * at either end), with a marker saying how much was cut.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (cut: number) => `\n…[truncated ${cut} characters]…\n`;
  const budget = Math.max(0, max - marker(text.length).length);
  const head = Math.ceil(budget * 0.7);
  const tail = budget - head;
  const cut = text.length - head - tail;
  return text.slice(0, head) + marker(cut) + (tail > 0 ? text.slice(text.length - tail) : "");
}

export function messageChars(m: Message): number {
  let n = m.content?.length ?? 0;
  if (m.role === "assistant" && m.tool_calls) {
    for (const c of m.tool_calls) n += c.function.name.length + c.function.arguments.length;
  }
  return n;
}

export function totalChars(messages: readonly Message[]): number {
  return messages.reduce((n, m) => n + messageChars(m), 0);
}

/** Tool results this short are never elided. */
const ELIDE_KEEP = 600;
/** The most recent tool results are kept whole. */
const KEEP_RECENT_TOOL_RESULTS = 6;

/**
 * Shrinks the history below `maxChars`, oldest first and deterministically:
 * 1. older tool results (all but the last 6) are cut to their first 600 characters;
 * 2. then older assistant texts (not their tool calls) likewise;
 * 3. then the remaining tool results (except the last one) are cut the same way.
 * The system prompt and the task (first user message) are never touched.
 */
export function compact(messages: readonly Message[], maxChars: number): Message[] {
  const out = messages.map((m) => ({ ...m })) as Message[];
  if (totalChars(out) <= maxChars) return out;
  const toolIdx = out.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const older = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_TOOL_RESULTS));
  const assistantIdx = out.flatMap((m, i) =>
    m.role === "assistant" && i < out.length - 2 ? [i] : [],
  );
  const passes: number[][] = [older, assistantIdx, toolIdx.slice(0, -1)];
  let total = totalChars(out);
  for (const pass of passes) {
    for (const i of pass) {
      if (total <= maxChars) return out;
      const m = out[i]!;
      const content = m.content;
      if (content === null || content.length <= ELIDE_KEEP + 80) continue;
      const short = `${content.slice(0, ELIDE_KEEP)}\n…[older output elided to save context: ${content.length - ELIDE_KEEP} characters; repeat the call if you need it]`;
      total -= content.length - short.length;
      out[i] = { ...m, content: short } as Message;
    }
  }
  return out;
}
