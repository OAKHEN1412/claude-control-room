// `cr` — the terminal client of Claude Control Room. Runs as plain Node (type stripping): node cli/src/cr.ts <command>.
// Talks to the same WebSocket server as the web page, so one Runner job can be driven from both at the same time.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveAccount } from './accounts.ts';
import { APP_LOCK_HINT, isAppLockClose, readStdinLine, readTtyPassword, unlockIfRequired } from './auth.ts';
import type { AuthIo, TtyInput } from './auth.ts';
import { parseArgs, resolvePrefix, USAGE } from './args.ts';
import type { Command } from './args.ts';
import { runAttach } from './attach.ts';
import { CrClient } from './client.ts';
import type { State } from './client.ts';
import { formatList, listRows, makePaint, profileLabel } from './format.ts';
import type { Paint } from './format.ts';
import { runUpdateCommand } from './update.ts';

/** Server error text -> a Thai explanation (the raw text is kept after it). */
export function explain(error: string | undefined): string {
  const e = error ?? 'ไม่ทราบสาเหตุ';
  if (e.startsWith('cwd not allowed')) {
    return `โฟลเดอร์นี้ยังไม่อยู่ในรายการที่อนุญาต — ต้องเป็นโฟลเดอร์ที่เคยเปิด session ไว้แล้ว หรือ project root (ใช้ --cwd เลือกโฟลเดอร์อื่น)\n  (${e})`;
  }
  if (e.startsWith('cwd does not exist')) return `ไม่พบโฟลเดอร์นี้\n  (${e})`;
  if (e.startsWith('model not available')) return `โมเดลนี้ใช้ไม่ได้\n  (${e})`;
  if (e.startsWith('account is locked')) {
    return `โปรไฟล์นี้ล็อกด้วยรหัสผ่าน — ปลดล็อกในหน้าเว็บก่อน (กดที่โปรไฟล์ แล้วใส่รหัสผ่าน) หรือใช้ --account เลือกโปรไฟล์อื่น\n  (${e})`;
  }
  if (e.includes('ยังเปิดอยู่ใน terminal') || e.includes('terminal process is still running')) {
    return `${e}\n  ปิด session นั้นใน terminal ก่อน (พิมพ์ /exit) แล้วรัน cr resume อีกครั้ง`;
  }
  return e;
}

/** Job ids that `cr attach` accepts: live or recently dead Runner jobs. */
function runnerIds(st: State): string[] {
  return [...st.runners.keys()];
}

function allIds(st: State): string[] {
  return [...new Set([...st.runners.keys(), ...st.sessions.keys(), ...st.saved.map((s) => s.sessionId)])];
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
    rl.once('close', () => resolve(''));
  });
}

async function attachTo(port: number, id: string, paint: Paint, cookie: string | undefined): Promise<number> {
  return runAttach({ port, sessionId: id, paint, stdin: process.stdin, stdout: process.stdout, cookie });
}

/** Real stdin/stderr wiring for the app-lock unlock. Prompts and messages go to stderr; nothing is echoed. */
function authIo(): AuthIo {
  return {
    fetch: globalThis.fetch,
    stdinIsTTY: !!process.stdin.isTTY,
    readStdinLine: () => readStdinLine(process.stdin),
    readTtyPassword: (prompt) => readTtyPassword(process.stdin as unknown as TtyInput, process.stderr, prompt),
  };
}

export async function main(argv: string[]): Promise<number> {
  const paint = makePaint(!!process.stdout.isTTY && !process.env.NO_COLOR);
  const parsed = parseArgs(argv, process.cwd(), process.env);
  if (!parsed.ok) {
    console.error(paint.red(parsed.error));
    return 2;
  }
  const { port, command, machine } = parsed;
  if (command.kind === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command.kind === 'update') return runUpdateCommand(command); // no server needed: the updater restarts it
  // App lock: unlock once per process when the server asks for it. The cookie lives in memory only.
  const auth = await unlockIfRequired({
    base: `http://127.0.0.1:${port}`,
    pinStdin: parsed.pinStdin,
    io: authIo(),
    notify: (msg) => console.error(paint.dim(msg)),
  });
  if (!auth.ok) {
    console.error(paint.red(auth.error));
    return 1;
  }
  const client = new CrClient(port, { cookie: auth.cookie });
  try {
    await client.connect();
  } catch (e) {
    if (isAppLockClose(e)) {
      console.error(paint.red(APP_LOCK_HINT));
      return 1;
    }
    console.error(
      paint.red(`ต่อ Control Room ไม่ได้ที่ 127.0.0.1:${port} (${e instanceof Error ? e.message : String(e)})`) +
        `\n  เซิร์ฟเวอร์รันอยู่ไหม? (npm run start) ถ้าใช้พอร์ตอื่นให้ตั้ง CR_PORT หรือ --port`,
    );
    return 1;
  }
  try {
    return await run(command, client, port, paint, machine);
  } finally {
    client.close();
  }
}

async function run(command: Exclude<Command, { kind: 'help' }>, client: CrClient, port: number, paint: Paint, machine?: string): Promise<number> {
  const st = client.state;
  const extra = machine ? { machineId: machine } : {}; // hook for the remote-machines feature; ignored by servers without it
  switch (command.kind) {
    case 'update':
      return runUpdateCommand(command);
    case 'ls': {
      const rows = listRows([...st.sessions.values()], [...st.runners.values()], command.all, st.accounts);
      for (const l of formatList(rows, paint, process.stdout.columns ?? 100)) console.log(l);
      return 0;
    }
    case 'attach': {
      const r = resolvePrefix(command.id, allIds(st));
      if (!r.ok) {
        console.error(paint.red(r.error));
        return 1;
      }
      if (!st.runners.has(r.id)) {
        console.error(
          paint.red(`${r.id.slice(0, 8)} ไม่ใช่งานที่คุมจากเว็บ (เป็น session ใน terminal ที่ดูได้อย่างเดียว หรืองานที่จบแล้ว)`) +
            `\n  อยากสั่งได้ทั้งสองทาง: ปิดมันใน terminal แล้วรัน  cr resume ${r.id.slice(0, 8)}`,
        );
        return 1;
      }
      client.close();
      return attachTo(port, r.id, paint, client.cookie);
    }
    case 'takeover': {
      const r = resolvePrefix(command.id, [...st.sessions.keys()]);
      if (!r.ok) {
        console.error(paint.red(r.error));
        return 1;
      }
      if (st.runners.get(r.id)?.alive) {
        console.error(paint.dim(`${r.id.slice(0, 8)} คุมจากเว็บอยู่แล้ว — ต่อเข้าไปเลย`));
        client.close();
        return attachTo(port, r.id, paint, client.cookie);
      }
      const info = st.sessions.get(r.id);
      const label = info ? `${info.name || r.id.slice(0, 8)} (${info.title || '-'})` : r.id.slice(0, 8);
      if (!command.yes) {
        if (!process.stdin.isTTY) {
          console.error(paint.red('ต้องยืนยันใน terminal (หรือใช้ -y)'));
          return 2;
        }
        const yn = (await ask(`จะปิด claude ใน terminal ของ ${label} แล้วย้ายมาคุมจากเว็บ (ไม่ถามสิทธิ์) — ต่อไหม? [y/N] `)).trim().toLowerCase();
        if (yn !== 'y' && yn !== 'yes') {
          console.error(paint.dim('ยกเลิก'));
          return 1;
        }
      }
      const a = await client.send({ type: 'takeover', sessionId: r.id, ...extra }, 40_000);
      if (!a.ok) {
        console.error(paint.red(`ยึดมาคุมไม่สำเร็จ: ${explain(a.error)}`));
        return 1;
      }
      console.error(paint.dim(`ยึด ${r.id.slice(0, 8)} มาคุมแล้ว (ปิด claude ใน terminal ให้แล้ว)`));
      if (machine) {
        console.error(paint.dim(`งานอยู่บนเครื่อง ${machine} — เปิดดู/สั่งต่อได้จากหน้าเว็บ`));
        return 0;
      }
      client.close();
      return attachTo(port, r.id, paint, client.cookie);
    }
    case 'new': {
      // resolve --account before anything starts: an unknown or unusable profile stops here, no job is started
      let accountId: string | undefined;
      if (command.account !== undefined) {
        const r = resolveAccount(command.account, st.accounts);
        if (!r.ok) {
          console.error(paint.red(r.error));
          return 1;
        }
        accountId = r.id;
      }
      let prompt = command.prompt;
      if (prompt === '' && process.stdin.isTTY) prompt = (await ask('prompt> ')).trim();
      if (prompt === '') {
        console.error(paint.red('ต้องมี prompt: cr new "สิ่งที่ให้ทำ"'));
        return 2;
      }
      const a = await client.send({
        type: 'start',
        cwd: path.resolve(command.cwd),
        model: command.model,
        effort: command.effort,
        prompt,
        ...(accountId !== undefined ? { accountId } : {}),
        ...extra,
      });
      if (!a.ok || !a.sessionId) {
        console.error(paint.red(`เริ่มงานไม่สำเร็จ: ${explain(a.error)}`));
        return 1;
      }
      const who = accountId !== undefined ? ` ด้วยโปรไฟล์ ${profileLabel(accountId, st.accounts)}` : '';
      console.error(paint.dim(`เริ่มงาน ${a.sessionId.slice(0, 8)} (${command.model}, ${command.effort}) ใน ${command.cwd}${who}`));
      if (!command.attach) {
        console.log(a.sessionId);
        return 0;
      }
      client.close();
      return attachTo(port, a.sessionId, paint, client.cookie);
    }
    case 'resume': {
      const r = resolvePrefix(command.id, allIds(st));
      if (!r.ok) {
        console.error(paint.red(r.error));
        return 1;
      }
      if (!st.runners.get(r.id)?.alive) {
        const known = st.saved.some((s) => s.sessionId === r.id);
        const a = known
          ? await client.send({ type: 'saved_resume', sessionId: r.id, ...(command.model ? { model: command.model } : {}), ...(command.effort ? { effort: command.effort } : {}), ...extra })
          : await client.send({ type: 'adopt', sessionId: r.id, ...(command.model ? { model: command.model } : {}), ...(command.effort ? { effort: command.effort } : {}) });
        if (!a.ok) {
          console.error(paint.red(`เปิดต่อไม่สำเร็จ: ${explain(a.error)}`));
          return 1;
        }
        console.error(paint.dim(`เปิดงาน ${r.id.slice(0, 8)} ต่อแล้ว (idle — ยังไม่ได้สั่งอะไร)`));
      }
      client.close();
      return attachTo(port, r.id, paint, client.cookie);
    }
  }
}

// Start only when this file is the entry point.
const entry = process.argv[1];
if (entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      // let a piped stdout drain, then leave even if some handle is still open
      process.exitCode = code;
      setTimeout(() => process.exit(code), 300);
    },
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
