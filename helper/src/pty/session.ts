import { spawn, type IPty } from 'node-pty';
import { MONITOR_SESSION } from '../../../shared/protocol/protocol';
import { Scrollback } from './scrollback';
import { RESTORED_MARK, type ScrollbackStore } from './scrollback-store';

export interface SessionSpec {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** `replay` marks saved scrollback, as opposed to live output. */
type DataListener = (data: string, replay?: boolean) => void;
type ExitListener = (code: number) => void;

export class Session {
  readonly id: string;
  private readonly pty: IPty;
  private readonly scrollback: Scrollback;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private exitCode: number | null = null;

  /** `restored` is what a session of this id had on screen when the helper last stopped; it is replayed ahead of the new output. */
  constructor(spec: SessionSpec, scrollbackLimit: number, restored: string | null = null) {
    this.id = spec.id;
    this.scrollback = new Scrollback(scrollbackLimit);
    if (restored) this.scrollback.push(restored + RESTORED_MARK);
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

  /** The shell's process id, or null once it has exited. */
  get pid(): number | null {
    return this.exited ? null : this.pty.pid;
  }

  /** Stops reporting output and exit to attached clients, for a session about to be replaced. */
  silence(): void {
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  get exited(): boolean {
    return this.exitCode !== null;
  }

  /** Replays scrollback, then streams live output. Returns a detach function. */
  attach(onData: DataListener, onExit: ExitListener): () => void {
    const replay = this.scrollback.snapshot();
    if (replay) onData(replay, true);

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

  /** Everything a newly attached view would be replayed. */
  snapshot(): string {
    return this.scrollback.snapshot();
  }

  /** How many panels are watching this session. */
  get attached(): number {
    return this.dataListeners.size;
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

  /** With `saved`, a session starts with the scrollback kept for its id when the helper last stopped. */
  constructor(
    private readonly scrollbackLimit: number,
    private readonly saved?: ScrollbackStore,
  ) {}

  create(spec: SessionSpec): Session {
    if (this.sessions.has(spec.id)) throw new Error(`session ${spec.id} already exists`);
    const session = new Session(spec, this.scrollbackLimit, this.saved?.take(spec.id));
    this.sessions.set(spec.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Ends a session on purpose (archived, restarted, resumed elsewhere). A panel attached to it is not told, since it reads
   * an exit as its shell ending and closes the side panel, when it is about to move to another workspace.
   */
  remove(id: string): void {
    const session = this.sessions.get(id);
    session?.silence();
    session?.kill();
    this.sessions.delete(id);
    // A session ended on purpose (archived, restarted, resumed elsewhere) is not the one to bring back.
    this.saved?.drop(id);
  }

  /** Saves every running terminal's scrollback, for the helper that starts next. The system monitor redraws itself, so it is left out. */
  saveAll(): void {
    if (!this.saved) return;
    for (const session of this.sessions.values()) {
      if (!session.exited && session.id !== MONITOR_SESSION) this.saved.save(session.id, session.snapshot());
    }
  }

  killAll(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
  }
}
