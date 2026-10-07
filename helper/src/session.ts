import { spawn, type IPty } from 'node-pty';
import { Scrollback } from './scrollback';

export interface SessionSpec {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

type DataListener = (data: string) => void;
type ExitListener = (code: number) => void;

export class Session {
  readonly id: string;
  private readonly pty: IPty;
  private readonly scrollback: Scrollback;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private exitCode: number | null = null;

  constructor(spec: SessionSpec, scrollbackLimit: number) {
    this.id = spec.id;
    this.scrollback = new Scrollback(scrollbackLimit);
    this.pty = spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: spec.cwd,
      env: { ...inheritedEnv(), ...spec.env },
    });
    this.pty.onData((data) => {
      this.scrollback.push(data);
      for (const listener of this.dataListeners) listener(data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      for (const listener of this.exitListeners) listener(exitCode);
    });
  }

  get exited(): boolean {
    return this.exitCode !== null;
  }

  /** Replays scrollback, then streams live output. Returns a detach function. */
  attach(onData: DataListener, onExit: ExitListener): () => void {
    const replay = this.scrollback.snapshot();
    if (replay) onData(replay);

    if (this.exitCode !== null) {
      onExit(this.exitCode);
      return () => {};
    }

    this.dataListeners.add(onData);
    this.exitListeners.add(onExit);
    return () => {
      this.dataListeners.delete(onData);
      this.exitListeners.delete(onExit);
    };
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.pty.resize(cols, rows);
  }

  kill(): void {
    if (!this.exited) this.pty.kill();
  }
}

// If the helper was started from inside a Claude Code session, its markers would make
// every `claude` in our shells think it is that session's child (transcripts off, etc).
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'CLAUDECODE' || key.startsWith('CLAUDE_')) continue;
    env[key] = value;
  }
  return env;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly scrollbackLimit: number) {}

  create(spec: SessionSpec): Session {
    if (this.sessions.has(spec.id)) throw new Error(`session ${spec.id} already exists`);
    const session = new Session(spec, this.scrollbackLimit);
    this.sessions.set(spec.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    this.sessions.get(id)?.kill();
    this.sessions.delete(id);
  }

  killAll(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
  }
}
