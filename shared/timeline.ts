export type TimelineKind = 'you' | 'said' | 'tool';

export interface TimelineEvent {
  /** ISO 8601, or '' when the line carried no time. */
  at: string;
  kind: TimelineKind;
  /** The tool's name for `tool`; empty otherwise. */
  tool: string;
  /** What happened, in a line. */
  summary: string;
  /** The file it touched, for the tools that touch one. */
  file?: string;
}

const MAX_SUMMARY = 160;
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A tool call in a sentence: the description claude gave it, else what it was pointed at. */
export function describeTool(name: string, input: Record<string, unknown>): { summary: string; file?: string } {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (FILE_TOOLS.has(name) && file) return { summary: file, file };
  const description = str(input.description);
  switch (name) {
    case 'Bash':
      return { summary: oneLine(description || str(input.command)) };
    case 'Grep':
    case 'Glob':
      return { summary: oneLine(`${str(input.pattern)}${str(input.path) ? ` in ${str(input.path)}` : ''}`) };
    case 'WebFetch':
      return { summary: oneLine(str(input.url)) };
    case 'WebSearch':
      return { summary: oneLine(str(input.query)) };
    case 'Task':
    case 'Agent':
      return { summary: oneLine(description || str(input.prompt)) };
    default:
      return { summary: oneLine(description || str(input.command) || str(input.query) || str(input.url) || file) };
  }
}

interface Block {
  type?: string;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

/** The events one transcript line holds: what you said, what claude said, and each tool it called. */
export function eventsFromLine(line: string): TimelineEvent[] {
  // Only these carry anything the timeline shows, and most lines are neither.
  if (!line.includes('"message"')) return [];
  let parsed: { type?: string; timestamp?: unknown; isSidechain?: boolean; message?: { role?: string; content?: unknown } };
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const { message } = parsed;
  if (!message || parsed.isSidechain) return [];
  const at = typeof parsed.timestamp === 'string' ? parsed.timestamp : '';
  const events: TimelineEvent[] = [];

  if (parsed.type === 'user' && message.role === 'user') {
    // A plain string is something you typed; a list of blocks is usually tool results coming back.
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? (message.content as Block[]).filter((b) => b.type === 'text').map((b) => str(b.text)).join(' ') : '';
    // Slash-command and hook plumbing is wrapped in tags and is not you.
    if (text.trim() && !text.trimStart().startsWith('<')) events.push({ at, kind: 'you', tool: '', summary: oneLine(text) });
  } else if (parsed.type === 'assistant' && Array.isArray(message.content)) {
    for (const block of message.content as Block[]) {
      if (block.type === 'text' && str(block.text).trim()) events.push({ at, kind: 'said', tool: '', summary: oneLine(str(block.text)) });
      else if (block.type === 'tool_use') {
        const input = typeof block.input === 'object' && block.input !== null ? (block.input as Record<string, unknown>) : {};
        events.push({ at, kind: 'tool', tool: str(block.name) || 'tool', ...describeTool(str(block.name), input) });
      }
    }
  }
  return events;
}
