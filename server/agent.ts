import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from './prompt';

/** Read-only tool set: the agent answers questions and never edits. */
const TOOLS = 'Read,Grep,Glob,Bash';
const ALLOWED = [
  'Read', 'Grep', 'Glob',
  'Bash(git log *)', 'Bash(git show *)', 'Bash(git diff *)', 'Bash(git blame *)', 'Bash(git status *)',
  'Bash(git log)', 'Bash(git diff)', 'Bash(git status)',
  'Bash(grillai-sheet *)',
].join(',');

/**
 * Read-only helper commands for the agent (grillai-sheet), put on its PATH.
 * The folder sits at the package root: one level up from server/ when run
 * from source, two levels up from dist/server/ when built.
 */
function toolsDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.join(here, '..', 'tools'), path.join(here, '..', '..', 'tools')]) {
    if (existsSync(path.join(dir, 'grillai-sheet'))) return dir;
  }
  return null;
}

/** Claude Opus 5.5 answers questions unless GRILLAI_MODEL says otherwise. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AgentResult {
  text: string;
  sessionId: string | null;
  /** The validated object, when the run was given a jsonSchema. */
  structured: unknown;
}

export interface AgentRun {
  done: Promise<AgentResult>;
  kill: () => void;
}

export interface AgentOptions {
  cwd: string;
  prompt: string;
  resume?: string | null;
  /** Replaces the default "answer a question" instructions. */
  systemPrompt?: string;
  /** Ask for the final answer as an object matching this JSON Schema. */
  jsonSchema?: object;
  onText: (text: string) => void;
  onActivity: (activity: string) => void;
}

function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => (typeof p === 'string' ? path.relative(cwd, p) || p : '');
  switch (name) {
    case 'Read': return `Reading ${rel(input.file_path)}`;
    case 'Grep': return `Searching for "${String(input.pattern ?? '')}"`;
    case 'Glob': return `Finding files ${String(input.pattern ?? '')}`;
    case 'Bash': return `Running ${String(input.command ?? '').slice(0, 120)}`;
    case 'StructuredOutput': return 'Writing up the findings';
    default: return `Using ${name}`;
  }
}

/** Ask the locally installed, already logged-in Claude Code CLI one question. */
export function runClaude(opts: AgentOptions): AgentRun {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', TOOLS,
    '--allowedTools', ALLOWED,
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--append-system-prompt', opts.systemPrompt ?? SYSTEM_PROMPT,
  ];
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  args.push('--model', process.env.GRILLAI_MODEL || DEFAULT_MODEL);
  if (opts.resume) args.push('--resume', opts.resume);

  const tools = toolsDir();
  const child = spawn(process.env.GRILLAI_CLAUDE_BIN ?? 'claude', args, {
    cwd: opts.cwd,
    env: tools ? { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH ?? ''}` } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let killed = false;

  const done = new Promise<AgentResult>((resolve, reject) => {
    let sessionId: string | null = null;
    let text = '';
    let stderr = '';
    let result: { is_error?: boolean; result?: string; session_id?: string; structured_output?: unknown } | null = null;

    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? 'The Claude Code CLI (`claude`) was not found on PATH. Install it and log in, then ask again.'
            : err.message,
        ),
      );
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.prompt);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'stream_event') {
        const e = ev.event;
        if (e?.type === 'message_start') {
          text = '';
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          text += e.delta.text;
          opts.onText(text);
        }
      } else if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use') opts.onActivity(describeTool(block.name, block.input ?? {}, opts.cwd));
        }
      } else if (ev.type === 'result') {
        result = ev;
      }
    });

    child.on('close', (code) => {
      if (killed) return reject(new Error('Cancelled.'));
      if (result && !result.is_error && typeof result.result === 'string') {
        resolve({ text: result.result, sessionId: result.session_id ?? sessionId, structured: result.structured_output });
      } else {
        reject(new Error((result?.result || stderr.trim() || `claude exited with code ${code}`).toString()));
      }
    });
  });

  return {
    done,
    kill: () => {
      killed = true;
      child.kill('SIGTERM');
    },
  };
}
