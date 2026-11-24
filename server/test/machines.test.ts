// Machines: validation, seed once, reachability probe, ssh test, attach/detach texts, tailscale peers, commands parsing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MachineFields, ServerMsg } from '../../shared/protocol';
import { parseClientMsg } from '../src/commands';
import { WorklogDb } from '../src/db';
import { startServer, type RunningServer } from '../src/index';
import { MachineService, attachMessage, detachMessage, parseTailscalePeers, type ExecFileFn } from '../src/machines';
import { Watcher } from '../src/watcher';

let tmp: string;
let ssh: string;
let keyFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-mach-'));
  ssh = path.join(tmp, '.ssh');
  fs.mkdirSync(ssh);
  keyFile = path.join(ssh, 'my-key');
  fs.writeFileSync(keyFile, 'NOT A REAL KEY');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const JOB = 'job-session-1';
const good = (over: Partial<MachineFields> = {}): MachineFields => ({ name: 'office pc', host: '100.1.2.3', user: 'admin', keyPath: keyFile, shell: 'powershell', ...over });

function mk(over: { execFile?: ExecFileFn; connect?: any; live?: string[] } = {}) {
  const db = new WorklogDb(':memory:');
  const sent: { to: string; text: string }[] = [];
  const live = new Set(over.live ?? [JOB]);
  let n = 0;
  const svc = new MachineService({
    db,
    runner: {
      isAlive: (id) => live.has(id),
      send: (id, text) => {
        if (!live.has(id)) throw new Error('ended');
        sent.push({ to: id, text });
      },
    },
    sshDir: ssh,
    now: () => 5_000,
    newId: () => `m${++n}`,
    connect: over.connect,
    execFile: over.execFile,
  });
  return { db, svc, sent, live };
}
const noSeed = (svc: MachineService, db: WorklogDb) => {
  for (const m of db.listMachines()) svc.remove(m.id);
};

describe('seed', () => {
  it('starts empty: no built-in machines, and nothing is added on a second start', () => {
    const db = new WorklogDb(':memory:');
    const a = new MachineService({ db, sshDir: ssh });
    expect(a.list()).toEqual([]);
    new MachineService({ db, sshDir: ssh });
    expect(db.countMachines()).toBe(0);
  });

  it('does not touch a table that already has rows (older db)', () => {
    const db = new WorklogDb(':memory:');
    db.insertMachine({ id: 'x', name: 'x', host: 'h', user: '', keyPath: '', shell: 'cmd', notes: '', created: 1 });
    new MachineService({ db, sshDir: ssh });
    expect(db.listMachines().map((m) => m.id)).toEqual(['x']);
  });
});

describe('validation', () => {
  it('accepts a good machine, resolves ~ to an absolute key path under ~/.ssh and returns the id in add()', () => {
    const { svc, db } = mk();
    noSeed(svc, db);
    const id = svc.add(good());
    expect(id).toBe('m1');
    expect(svc.list()[0]).toMatchObject({ id: 'm1', name: 'office pc', host: '100.1.2.3', user: 'admin', keyPath: keyFile, shell: 'powershell', ssh: 'untested', reach: 'unknown' });
    expect(svc.add(good({ host: 'pc-01.tail.ts.net', user: '', keyPath: '', notes: ' a \n b ' }))).toBe('m2');
    expect(svc.list()[1]).toMatchObject({ user: '', keyPath: '', ssh: 'not_configured', notes: 'a b' });
  });

  it('rejects bad names, hosts, users, shells and keys with Thai errors', () => {
    const { svc } = mk();
    const bad = (o: Partial<MachineFields> | Record<string, unknown>, text?: string) => {
      expect(() => svc.add({ ...good(), ...o } as MachineFields)).toThrow(text);
    };
    bad({ name: '' }, 'ชื่อเครื่อง');
    bad({ name: 'x'.repeat(41) }, 'ชื่อเครื่อง');
    bad({ host: 'bad host!' }, 'host');
    bad({ host: '-oProxyCommand=evil' }, 'host');
    bad({ host: 'a;b' }, 'host');
    bad({ host: '' }, 'host');
    bad({ user: 'a b' }, 'user');
    bad({ user: '-oStuff' }, 'user');
    bad({ user: 'x'.repeat(65) }, 'user');
    bad({ shell: 'zsh' }, 'shell');
    bad({ keyPath: path.join(tmp, 'outside-key') }, '~/.ssh');
    bad({ keyPath: path.join(ssh, '..', 'outside-key') }, '~/.ssh');
    bad({ keyPath: path.join(ssh, 'missing-key') }, 'ไม่พบไฟล์ key');
    bad({ keyPath: ssh }, '~/.ssh'); // the folder itself is not a key
    expect(() => svc.update('nope', good())).toThrow('ไม่พบเครื่องนี้');
  });

  it('never reads the key file contents', () => {
    const { svc, db } = mk();
    noSeed(svc, db);
    const orig = fs.readFileSync;
    const reads: string[] = [];
    (fs as any).readFileSync = (p: any, ...rest: any[]) => {
      reads.push(String(p));
      return (orig as any)(p, ...rest);
    };
    try {
      svc.add(good());
    } finally {
      (fs as any).readFileSync = orig;
    }
    expect(reads.filter((r) => r.includes('my-key'))).toEqual([]);
  });

  it('update re-validates, keeps the id and clears an old test result', async () => {
    const exec: ExecFileFn = async () => ({ stdout: 'cr-ok\n', stderr: '' });
    const { svc, db } = mk({ execFile: exec });
    noSeed(svc, db);
    const id = svc.add(good());
    await svc.test(id);
    expect(svc.list()[0].ssh).toBe('ok');
    svc.update(id, good({ name: 'renamed' }));
    expect(svc.list()[0]).toMatchObject({ id, name: 'renamed', ssh: 'untested' });
    expect(() => svc.update(id, good({ host: '' }))).toThrow('host');
  });

  it('delete removes the machine and its attachments', () => {
    const { svc, db, sent } = mk();
    noSeed(svc, db);
    const id = svc.add(good());
    const id2 = svc.add(good({ name: 'other' }));
    svc.attachJob(JOB, id);
    svc.attachJob(JOB, id2);
    expect(svc.attachments()).toHaveLength(2);
    svc.remove(id);
    expect(svc.attachments().map((a) => a.machineId)).toEqual([id2]);
    expect(svc.list().map((m) => m.id)).toEqual([id2]);
    expect(sent).toHaveLength(2);
    expect(() => svc.remove(id)).toThrow('ไม่พบเครื่องนี้');
  });
});

describe('reachability probe', () => {
  it('connects to host:22 with a 2 s timeout and records online / offline + lastCheck', async () => {
    const calls: [string, number, number][] = [];
    const connect = async (h: string, p: number, t: number) => {
      calls.push([h, p, t]);
      return h === '100.64.0.10';
    };
    const { svc, db } = mk({ connect });
    db.insertMachine({ id: 'a', name: 'pc-a', host: '100.64.0.10', user: '', keyPath: '', shell: 'cmd', notes: '', created: 1 });
    db.insertMachine({ id: 'b', name: 'pc-b', host: '100.64.0.11', user: '', keyPath: '', shell: 'powershell', notes: '', created: 2 });
    const changes: unknown[] = [];
    svc.on('change', (v) => changes.push(v));
    await svc.probe();
    expect(calls).toEqual([
      ['100.64.0.10', 22, 2000],
      ['100.64.0.11', 22, 2000],
    ]);
    const l = svc.list();
    expect(l[0]).toMatchObject({ reach: 'online', lastCheck: 5_000 });
    expect(l[1]).toMatchObject({ reach: 'offline', ssh: 'not_configured' });
    expect(changes).toHaveLength(1);
    await svc.probe(); // nothing changed: no new broadcast
    expect(changes).toHaveLength(1);
  });

  it('a connector that throws counts as offline', async () => {
    const { svc } = mk({ connect: async () => { throw new Error('boom'); } });
    await svc.probe();
    expect(svc.list().every((m) => m.reach === 'offline')).toBe(true);
  });
});

describe('machine_test', () => {
  it('ok when stdout contains cr-ok; runs ssh with the exact args via execFile', async () => {
    const calls: { file: string; args: string[]; opts: { timeout: number } }[] = [];
    const exec: ExecFileFn = async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { stdout: 'cr-ok\r\n', stderr: '' };
    };
    const { svc, db } = mk({ execFile: exec });
    noSeed(svc, db);
    const id = svc.add(good());
    await svc.test(id);
    expect(calls).toEqual([
      {
        file: 'ssh',
        args: ['-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', 'admin@100.1.2.3', 'echo cr-ok'],
        opts: { timeout: 10_000 },
      },
    ]);
    expect(svc.list()[0]).toMatchObject({ ssh: 'ok' });
    expect(svc.list()[0].sshError).toBeUndefined();
  });

  it('fail records the first stderr line clipped to 200', async () => {
    const exec: ExecFileFn = async () => {
      const e: any = new Error('Command failed');
      e.stdout = '';
      e.stderr = `\nPermission denied (publickey).${'x'.repeat(300)}\nsecond line`;
      throw e;
    };
    const { svc, db } = mk({ execFile: exec });
    noSeed(svc, db);
    const id = svc.add(good());
    await svc.test(id);
    const m = svc.list()[0];
    expect(m.ssh).toBe('fail');
    expect(m.sshError!.startsWith('Permission denied (publickey).')).toBe(true);
    expect(m.sshError!.length).toBe(200);
    expect(m.sshError).not.toContain('second line');
  });

  it('refuses an unconfigured machine and an unknown id; a resolved call without cr-ok is a fail', async () => {
    const { svc, db } = mk({ execFile: async () => ({ stdout: 'hello', stderr: 'Connection timed out' }) });
    noSeed(svc, db);
    await expect(svc.test('nope')).rejects.toThrow('ไม่พบเครื่องนี้');
    const bare = svc.add(good({ user: '', keyPath: '' }));
    await expect(svc.test(bare)).rejects.toThrow('ยังไม่ได้ตั้งค่า SSH');
    const id = svc.add(good());
    await svc.test(id);
    expect(svc.list().find((m) => m.id === id)).toMatchObject({ ssh: 'fail', sshError: 'Connection timed out' });
  });
});

describe('attach / detach', () => {
  it('sends the exact message once, records the attachment, is idempotent per pair', () => {
    const { svc, db, sent } = mk();
    noSeed(svc, db);
    const id = svc.add(good({ notes: 'โน้ต' }));
    svc.attachJob(JOB, id);
    svc.attachJob(JOB, id);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(JOB);
    expect(sent[0].text).toBe(
      [
        '[เชื่อมเครื่อง office pc]',
        'คุณทำงานบนเครื่อง office pc (100.1.2.3) ได้ผ่าน SSH:',
        `  ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes admin@100.1.2.3 "<คำสั่ง>"`,
        'shell ฝั่งโน้น = powershell. ใช้ path แบบเต็ม, ห้ามคำสั่งที่ลบ/ติดตั้ง/รีสตาร์ทโดยไม่ถามผู้ใช้ก่อน. ถ้ายังไม่ได้รับคำสั่งงาน ให้ตอบสั้นๆ ว่ารับทราบ.',
        'หมายเหตุเครื่อง: โน้ต',
      ].join('\n'),
    );
    expect(svc.attachments()).toEqual([{ sessionId: JOB, machineId: id, at: 5_000 }]);
    // no notes line when there are none
    const id2 = svc.add(good({ name: 'b' }));
    svc.attachJob(JOB, id2);
    expect(sent[1].text.split('\n')).toHaveLength(4);
    expect(sent[1].text).toBe(attachMessage({ name: 'b', host: '100.1.2.3', user: 'admin', keyPath: keyFile, shell: 'powershell', notes: '' }));
  });

  it('refusals: not a live Runner job, unknown machine, ssh not configured', () => {
    const { svc, db, sent } = mk();
    noSeed(svc, db);
    const bare = svc.add(good({ user: '', keyPath: '' }));
    const ok = svc.add(good());
    expect(() => svc.attachJob('terminal-session', ok)).toThrow('ต่อเครื่องได้เฉพาะงานที่คุมจากเว็บ');
    expect(() => svc.attachJob(JOB, 'nope')).toThrow('ไม่พบเครื่องนี้');
    expect(() => svc.attachJob(JOB, bare)).toThrow('เครื่องนี้ยังไม่ได้ตั้งค่า SSH');
    expect(sent).toHaveLength(0);
    expect(svc.attachments()).toEqual([]);
  });

  it('detach removes the attachment and tells a live job; a gone job just loses the attachment', () => {
    const { svc, db, sent, live } = mk();
    noSeed(svc, db);
    const id = svc.add(good());
    svc.attachJob(JOB, id);
    svc.detachJob(JOB, id);
    expect(sent[1]).toEqual({ to: JOB, text: '[ยกเลิกเชื่อมเครื่อง office pc] ไม่ต้องใช้เครื่องนี้แล้ว' });
    expect(sent[1].text).toBe(detachMessage('office pc'));
    expect(svc.attachments()).toEqual([]);
    svc.detachJob(JOB, id); // idempotent
    expect(sent).toHaveLength(2);
    svc.attachJob(JOB, id);
    live.delete(JOB);
    svc.detachJob(JOB, id);
    expect(sent).toHaveLength(3); // only the attach message
    expect(svc.attachments()).toEqual([]);
  });

  it('attachments are dropped when the session goes away', () => {
    const { svc, db } = mk();
    noSeed(svc, db);
    const id = svc.add(good());
    svc.attachJob(JOB, id);
    svc.onSessionGone(JOB);
    expect(svc.attachments()).toEqual([]);
  });
});

describe('tailscale peers', () => {
  const FIXTURE = JSON.stringify({
    Self: { HostName: 'DESKTOP-SELF', TailscaleIPs: ['100.9.9.9', 'fd7a::1'], OS: 'windows', Online: true },
    Peer: {
      'nodekey:a': { HostName: 'DESKTOP-SERVER', TailscaleIPs: ['fd7a:115c::1', '100.64.0.10'], OS: 'windows', Online: true },
      'nodekey:b': { HostName: 'Desktop-Sales2', TailscaleIPs: ['100.64.0.11'], OS: 'windows', Online: false },
      'nodekey:c': { HostName: 'v6only', TailscaleIPs: ['fd7a::5'], OS: 'linux', Online: true },
      'nodekey:d': { TailscaleIPs: ['100.1.1.1'] },
    },
  });

  it('parses HostName lowercased, the first IPv4, os and online; Self and IPv6-only nodes are left out', () => {
    expect(parseTailscalePeers(FIXTURE)).toEqual([
      { name: 'desktop-sales2', ip: '100.64.0.11', os: 'windows', online: false },
      { name: 'desktop-server', ip: '100.64.0.10', os: 'windows', online: true },
    ]);
    expect(parseTailscalePeers('not json')).toEqual([]);
    expect(parseTailscalePeers('{}')).toEqual([]);
  });

  it('refreshPeers uses execFile (no shell) and an unavailable tailscale gives []', async () => {
    const calls: string[][] = [];
    const ok = mk({
      execFile: async (file, args) => {
        calls.push([file, ...args]);
        return { stdout: FIXTURE, stderr: '' };
      },
    });
    await ok.svc.refreshPeers();
    expect(calls[0]).toEqual(['tailscale', 'status', '--json']);
    expect(ok.svc.tailscalePeers()).toHaveLength(2);
    const missing = mk({ execFile: async () => { throw new Error('ENOENT'); } });
    await missing.svc.refreshPeers();
    expect(missing.svc.tailscalePeers()).toEqual([]);
    expect(missing.svc.view().peers).toEqual([]);
  });
});

describe('commands.ts parsing', () => {
  const fields = { name: ' pc ', host: '100.1.2.3', user: 'u', keyPath: '~/.ssh/k', shell: 'cmd' };
  it('machine_add / machine_update', () => {
    expect(parseClientMsg({ type: 'machine_add', reqId: 'r', ...fields })).toEqual({
      ok: true,
      msg: { type: 'machine_add', reqId: 'r', name: 'pc', host: '100.1.2.3', user: 'u', keyPath: '~/.ssh/k', shell: 'cmd' },
    });
    expect(parseClientMsg({ type: 'machine_add', reqId: 'r', ...fields, notes: 'n' })).toMatchObject({ ok: true, msg: { notes: 'n' } });
    expect(parseClientMsg({ type: 'machine_update', reqId: 'r', machineId: 'm_1', ...fields })).toMatchObject({ ok: true, msg: { type: 'machine_update', machineId: 'm_1' } });
    expect(parseClientMsg({ type: 'machine_update', reqId: 'r', ...fields }).ok).toBe(false);
    for (const bad of [{ name: '' }, { host: 'a b' }, { user: 'a b' }, { shell: 'zsh' }, { keyPath: 5 }, { notes: 'x'.repeat(301) }, { host: undefined }]) {
      expect(parseClientMsg({ type: 'machine_add', reqId: 'r', ...fields, ...bad }).ok).toBe(false);
    }
  });
  it('machine_delete / machine_test / machine_attach / machine_detach', () => {
    expect(parseClientMsg({ type: 'machine_delete', reqId: 'r', machineId: 'm1' })).toEqual({ ok: true, msg: { type: 'machine_delete', reqId: 'r', machineId: 'm1' } });
    expect(parseClientMsg({ type: 'machine_test', reqId: 'r', machineId: 'm1' })).toEqual({ ok: true, msg: { type: 'machine_test', reqId: 'r', machineId: 'm1' } });
    expect(parseClientMsg({ type: 'machine_test', reqId: 'r', machineId: '../x' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'machine_delete', reqId: 'r' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'machine_attach', reqId: 'r', sessionId: 's1', machineId: 'm1' })).toEqual({ ok: true, msg: { type: 'machine_attach', reqId: 'r', sessionId: 's1', machineId: 'm1' } });
    expect(parseClientMsg({ type: 'machine_detach', reqId: 'r', sessionId: 's1', machineId: 'm1' })).toEqual({ ok: true, msg: { type: 'machine_detach', reqId: 'r', sessionId: 's1', machineId: 'm1' } });
    expect(parseClientMsg({ type: 'machine_attach', reqId: 'r', sessionId: '', machineId: 'm1' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'machine_attach', reqId: 'r', sessionId: 's1' }).ok).toBe(false);
  });
});

describe('server: snapshot, broadcast, ack machineId', () => {
  let server: RunningServer | null = null;
  let watcher: Watcher | null = null;
  afterEach(async () => {
    await server?.close();
    watcher?.stop();
    server = null;
  });
  const wait = async (cond: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('snapshot has machines/attachments/peers; add acks the machineId and broadcasts `machines`; commands work without a runner', async () => {
    const claude = path.join(tmp, 'claude');
    fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
    watcher = new Watcher({ claudeDir: claude, pollMs: 50 });
    const db = new WorklogDb(':memory:');
    const svc = new MachineService({ db, sshDir: ssh, newId: () => 'm_new' });
    server = await startServer({ watcher, port: 0, machines: svc, log: () => {} });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const msgs: ServerMsg[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on('open', () => r()));
    await wait(() => msgs.some((m) => m.type === 'snapshot'));
    const snap = msgs.find((m) => m.type === 'snapshot') as Extract<ServerMsg, { type: 'snapshot' }>;
    expect(snap.machines!.map((m) => m.id)).toEqual([]);
    expect(snap.attachments).toEqual([]);
    expect(snap.peers).toEqual([]);

    ws.send(JSON.stringify({ type: 'machine_add', reqId: 'a1', ...good() }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 'a1'));
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 'a1')).toMatchObject({ ok: true, machineId: 'm_new' });
    await wait(() => msgs.some((m) => m.type === 'machines'));
    const bc = msgs.find((m) => m.type === 'machines') as Extract<ServerMsg, { type: 'machines' }>;
    expect(bc.machines.map((m) => m.id)).toContain('m_new');
    expect(Array.isArray(bc.attachments)).toBe(true);

    ws.send(JSON.stringify({ type: 'machine_attach', reqId: 'a2', sessionId: 's1', machineId: 'm_new' }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 'a2'));
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 'a2')).toMatchObject({ ok: false, error: 'ต่อเครื่องได้เฉพาะงานที่คุมจากเว็บ' });
    ws.send(JSON.stringify({ type: 'machine_add', reqId: 'a3', ...good({ host: 'bad host' }) }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 'a3'));
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 'a3')).toMatchObject({ ok: false });
    ws.send(JSON.stringify({ type: 'machine_delete', reqId: 'a4', machineId: 'm_new' }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 'a4'));
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 'a4')).toMatchObject({ ok: true, machineId: 'm_new' });
    ws.close();
  });
});
