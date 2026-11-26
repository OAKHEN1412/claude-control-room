// `cr attach`: the terminal as a second client of one Runner job. AttachController holds the logic (what to print for
// a state update, what a typed line does) without any I/O so it can be unit-tested; runAttach wires it to readline
// and the WebSocket (with reconnect, so a server restart that auto-resumes the job keeps the terminal attached).
import readline from 'node:readline';
import type { PendingRequest, RunnerState, SessionInfo } from '../../shared/protocol.ts';
import { AnswerFlow } from './answers.ts';
import { CrClient } from './client.ts';
import type { Ack } from './client.ts';
import { TimelinePrinter, clip } from './format.ts';
import type { Paint } from './format.ts';

export const HELP_LINES = [
  'พิมพ์ข้อความแล้วกด Enter = ส่งเข้างาน (ถ้างานกำลังทำอยู่ จะเข้าคิว)',
  '/stop    หยุดงานที่กำลังทำ      /close   ปิดงาน (ถามยืนยัน)',
  '/now     หยุดคำสั่งที่รันอยู่ แล้วส่งข้อความที่รออยู่ทันที (ถามยืนยัน)',
  '/detach  ออกโดยงานยังรันต่อ (หรือ Ctrl+C)      /skip  ข้ามคำถามที่รออยู่',
];

/** Lines for the "ข้อความรอส่ง" notice: how many wait, what they say, what the job is running now, and the /now hint. */
export function queuedNotice(p: Paint, runner: RunnerState, session: SessionInfo | undefined): string[] {
  const out = [p.yellow(`ข้อความรอส่ง ${runner.queued} · จะถึง Claude หลังคำสั่งที่กำลังรันเสร็จ`)];
  for (const q of runner.queuedTexts ?? []) out.push(p.dim(`  • ${clip(q.text.replace(/\s+/g, ' '), 100)}`));
  const last = session?.timeline[session.timeline.length - 1];
  if (runner.busy && last && last.kind === 'tool') out.push(p.dim(`  กำลังรันอยู่: ${last.text}`));
  out.push(p.dim('  พิมพ์ /now เพื่อหยุดแล้วส่งเลย'));
  return out;
}

export interface ControllerOptions {
  sessionId: string;
  paint: Paint;
  send: (cmd: Record<string, unknown>) => Promise<Ack>;
  print: (lines: string[]) => void;
  /** Leave the program. `code` 0 = normal. */
  exit: (code: number, message?: string) => void;
}

export class AttachController {
  private readonly o: ControllerOptions;
  private readonly printer: TimelinePrinter;
  private flow: AnswerFlow | null = null;
  private readonly queue: PendingRequest[] = [];
  private readonly seen = new Set<string>(); // request ids already shown
  private closing = false;
  private sendingNow = false;
  private lastQueued = 0;
  private wasBusy: boolean | null = null;
  private done = false;
  runner: RunnerState | undefined;

  constructor(o: ControllerOptions) {
    this.o = o;
    this.printer = new TimelinePrinter(o.paint);
  }

  prompt(): string {
    if (this.closing) return 'ปิดงานนี้? (y/n)> ';
    if (this.sendingNow) return 'หยุดคำสั่งที่รันอยู่แล้วส่งเลย? (y/n)> ';
    if (this.flow) return this.flow.prompt();
    return 'cr> ';
  }

  /** True when nothing is running or waiting any more (used to leave after stdin ended). */
  get settled(): boolean {
    const r = this.runner;
    return !r || (!r.busy && r.queued === 0 && r.pending.length === 0);
  }

  /** The job left the Runner (closed, or the server forgot it). */
  onGone(): void {
    this.finish(0, 'งานนี้ปิดแล้ว');
  }

  private finish(code: number, message?: string): void {
    if (this.done) return;
    this.done = true;
    this.o.exit(code, message);
  }

  /** A session / runner update for the attached job. Prints what is new and starts questions. */
  onUpdate(session: SessionInfo | undefined, runner: RunnerState | undefined): void {
    if (this.done) return;
    const p = this.o.paint;
    const out: string[] = [];
    if (session) out.push(...this.printer.update(session.timeline));
    this.runner = runner;
    if (runner) {
      if (this.wasBusy !== null && runner.busy !== this.wasBusy) out.push(p.dim(runner.busy ? '✻ กำลังทำ…' : '✻ ว่าง'));
      this.wasBusy = runner.busy;
      if (runner.queued !== this.lastQueued) {
        if (runner.queued > 0) out.push(...queuedNotice(p, runner, session));
        else if (this.lastQueued > 0) out.push(p.dim('(ไม่มีข้อความรอส่งแล้ว)'));
        this.lastQueued = runner.queued;
      }
      // a question answered somewhere else (the web) is dropped here
      const open = new Set(runner.pending.map((x) => x.requestId));
      if (this.flow && !open.has(this.flow.requestId)) {
        out.push(p.dim('(คำถามนี้ถูกตอบจากที่อื่นแล้ว)'));
        this.flow = null;
      }
      for (let i = this.queue.length - 1; i >= 0; i--) if (!open.has(this.queue[i].requestId)) this.queue.splice(i, 1);
      for (const q of runner.pending) {
        if (!this.seen.has(q.requestId)) {
          this.seen.add(q.requestId);
          this.queue.push(q);
        }
      }
      if (!this.flow && this.queue.length > 0) {
        this.flow = new AnswerFlow(this.queue.shift() as PendingRequest, p);
        out.push(...this.flow.intro());
      }
    }
    if (out.length > 0) this.o.print(out);
    if (runner && !runner.alive) this.finish(0, runner.error ? `งานหยุดแล้ว: ${clip(runner.error, 200)}` : 'งานหยุดแล้ว');
  }

  /** One line typed by the user. */
  async onLine(line: string): Promise<void> {
    if (this.done) return;
    const p = this.o.paint;
    const t = line.trim();
    if (this.closing) {
      this.closing = false;
      if (/^(y|yes|ใช่|ยืนยัน)$/i.test(t)) {
        const a = await this.o.send({ type: 'close', sessionId: this.o.sessionId });
        if (a.ok) this.finish(0, 'ปิดงานแล้ว');
        else this.o.print([p.red(`ปิดงานไม่ได้: ${a.error ?? ''}`)]);
      } else {
        this.o.print([p.dim('ไม่ปิด')]);
      }
      return;
    }
    if (this.sendingNow) {
      this.sendingNow = false;
      if (/^(y|yes|ใช่|ยืนยัน)$/i.test(t)) {
        const a = await this.o.send({ type: 'send_now', sessionId: this.o.sessionId });
        this.o.print([a.ok ? p.dim(typeof a.answer === 'string' ? a.answer : 'หยุดแล้วส่งข้อความที่รออยู่แล้ว') : p.red(`ส่งเลยไม่ได้: ${a.error ?? ''}`)]);
      } else {
        this.o.print([p.dim('ไม่ส่งเลย ข้อความยังรออยู่')]);
      }
      return;
    }
    if (this.flow) {
      const step = this.flow.handle(line);
      const flow = this.flow;
      if (step.lines.length > 0) this.o.print(step.lines);
      if (step.done) {
        this.flow = null;
        const a = await this.o.send({
          type: 'answer',
          sessionId: this.o.sessionId,
          requestId: flow.requestId,
          behavior: step.done.behavior,
          ...(step.done.answers ? { answers: step.done.answers } : {}),
          ...(step.done.message ? { message: step.done.message } : {}),
        });
        if (!a.ok) this.o.print([p.red(`ส่งคำตอบไม่สำเร็จ: ${a.error ?? ''}`)]);
        if (this.queue.length > 0) {
          this.flow = new AnswerFlow(this.queue.shift() as PendingRequest, p);
          this.o.print(this.flow.intro());
        }
      }
      return;
    }
    if (t === '') return;
    switch (t) {
      case '/detach':
      case '/quit':
      case '/exit':
        this.finish(0, 'ออกแล้ว งานยังทำงานต่อ');
        return;
      case '/close':
        this.closing = true;
        this.o.print([p.yellow('จะปิดงานนี้ (หยุดและเอาออกจากหน้าเว็บ) — พิมพ์ y เพื่อยืนยัน')]);
        return;
      case '/now':
        if (!this.runner || this.runner.queued <= 0) {
          this.o.print([p.dim('ไม่มีข้อความรอส่ง')]);
          return;
        }
        this.sendingNow = true;
        this.o.print([p.yellow(`จะหยุดคำสั่งที่กำลังรันอยู่ แล้วส่งข้อความที่รออยู่ ${this.runner.queued} ข้อความรวมเป็นข้อความเดียว — พิมพ์ y เพื่อยืนยัน`)]);
        return;
      case '/stop': {
        const a = await this.o.send({ type: 'stop', sessionId: this.o.sessionId });
        this.o.print([a.ok ? p.dim('สั่งหยุดแล้ว') : p.red(`หยุดไม่ได้: ${a.error ?? ''}`)]);
        return;
      }
      case '/help':
      case '/?':
        this.o.print(HELP_LINES.map((l) => p.dim(l)));
        return;
    }
    this.printer.noteSent(t);
    const a = await this.o.send({ type: 'send', sessionId: this.o.sessionId, text: line.replace(/\s+$/, '') });
    if (!a.ok) this.o.print([p.red(`ส่งไม่สำเร็จ: ${a.error ?? ''}`)]);
  }
}

export interface RunAttachOptions {
  port: number;
  sessionId: string;
  paint: Paint;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  reconnectMs?: number;
  reconnectTries?: number;
  /** After stdin ended (a pipe), wait this long with no news once the job is idle, then leave. */
  eofSettleMs?: number;
  /** How long a missing job is waited for after a reconnect (the server resumes it a moment after it listens). */
  rejoinMs?: number;
  /** App-lock session cookie (`cr_session=...`) for the WebSocket handshake, when the server is locked. */
  cookie?: string;
}

/** Runs an interactive attach until detach / close / job end. Resolves with the exit code. */
export function runAttach(o: RunAttachOptions): Promise<number> {
  return new Promise<number>((resolve) => {
    const tty = !!o.stdin.isTTY && !!o.stdout.isTTY;
    let client: CrClient | null = null;
    let finished = false;
    let eof = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let goneTimer: ReturnType<typeof setTimeout> | null = null;
    const rl = readline.createInterface({ input: o.stdin, output: o.stdout, terminal: tty, prompt: 'cr> ' });

    const print = (lines: string[]): void => {
      if (finished) return;
      if (tty) {
        readline.cursorTo(o.stdout, 0);
        readline.clearLine(o.stdout, 0);
      }
      o.stdout.write(`${lines.join('\n')}\n`);
      if (tty) {
        rl.setPrompt(ctl.prompt());
        rl.prompt(true);
      }
    };
    const exit = (code: number, message?: string): void => {
      if (finished) return;
      if (message) print([code === 0 ? o.paint.dim(`— ${message} —`) : o.paint.red(message)]);
      finished = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (goneTimer) clearTimeout(goneTimer);
      client?.close();
      rl.close();
      resolve(code);
    };
    const ctl: AttachController = new AttachController({
      sessionId: o.sessionId,
      paint: o.paint,
      send: (cmd) => (client ? client.send(cmd) : Promise.resolve({ ok: false, error: 'ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์' })),
      print,
      exit,
    });

    const maybeLeaveAfterEof = (): void => {
      if (!eof || finished) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      if (ctl.settled) settleTimer = setTimeout(() => exit(0), o.eofSettleMs ?? 2500);
    };

    const refresh = (): void => {
      if (!client) return;
      const runner = client.state.runners.get(o.sessionId);
      if (goneTimer && runner) {
        clearTimeout(goneTimer);
        goneTimer = null;
      }
      ctl.onUpdate(client.state.sessions.get(o.sessionId), runner);
      maybeLeaveAfterEof();
    };

    const attachClient = (c: CrClient): void => {
      client = c;
      c.on('change', (msg: { type: string; sessionId?: string }) => {
        if (msg.type === 'runner_removed' && msg.sessionId === o.sessionId) {
          ctl.onGone();
          return;
        }
        refresh();
      });
      c.on('close', () => {
        if (finished) return;
        void reconnect();
      });
    };

    const reconnect = async (): Promise<void> => {
      print([o.paint.yellow('— เซิร์ฟเวอร์หลุด รอเชื่อมต่อใหม่ —')]);
      const tries = o.reconnectTries ?? 60;
      for (let i = 0; i < tries && !finished; i++) {
        await new Promise((r) => setTimeout(r, o.reconnectMs ?? 1500));
        if (finished) return;
        const c = new CrClient(o.port, { cookie: o.cookie });
        try {
          await c.connect(2000);
        } catch {
          continue;
        }
        attachClient(c);
        print([o.paint.green('— เชื่อมต่อใหม่แล้ว —')]);
        if (!c.state.runners.has(o.sessionId)) {
          // the server resumes saved jobs just after it starts listening: give it a moment
          goneTimer = setTimeout(() => ctl.onGone(), o.rejoinMs ?? 20_000);
        }
        refresh();
        return;
      }
      exit(1, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    };

    rl.on('line', (line) => {
      void ctl.onLine(line).then(() => {
        if (tty && !finished) {
          rl.setPrompt(ctl.prompt());
          rl.prompt(true);
        }
      });
    });
    rl.on('SIGINT', () => exit(0, 'ออกแล้ว งานยังทำงานต่อ'));
    rl.on('close', () => {
      if (finished) return;
      if (tty) {
        exit(0, 'ออกแล้ว งานยังทำงานต่อ');
        return;
      }
      eof = true; // a pipe ended: leave once the job is idle and the timeline caught up
      maybeLeaveAfterEof();
    });

    const first = new CrClient(o.port, { cookie: o.cookie });
    first.connect().then(
      () => {
        attachClient(first);
        o.stdout.write(`${o.paint.dim(`ต่อกับงาน ${o.sessionId.slice(0, 8)} แล้ว — /help ดูคำสั่ง · /detach ออกโดยงานยังรันต่อ`)}\n`);
        refresh();
        if (tty) {
          rl.setPrompt(ctl.prompt());
          rl.prompt();
        }
      },
      (e) => exit(1, `เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (${e instanceof Error ? e.message : String(e)})`),
    );
  });
}
