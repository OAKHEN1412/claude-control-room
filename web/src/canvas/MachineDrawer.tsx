// Machine popover ("+ เครื่อง") and the machine drawer (details, edit, connection test, delete).
import { useEffect, useRef, useState } from 'react';
import type { Command } from '../components/Controls';
import { EMPTY_MACHINE_FORM, REACH_WORD, agentLine, SSH_WORD, formFromMachine, formPayload, shortKeyPath, type MachineForm } from '../machineForm';
import type { MachineAttachment, MachineInfo, TailscalePeer } from '../protocolNext';
import { CloseIcon } from './icons';
import { MachineFormView } from './MachineFormView';

const offline = 'ยังสั่งงานไม่ได้';
const CONFIRM_MS = 4000;

export function MachineAddPopover({ peers, command, onAdded, onClose }: { peers: TailscalePeer[]; command: Command | undefined; onAdded: (machineId: string | undefined) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (f: MachineForm) => {
    if (!command) {
      setError(offline);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await command({ type: 'machine_add', ...formPayload(f) });
    setBusy(false);
    if (r.ok) onAdded(r.machineId);
    else setError(r.error ?? 'ทำไม่สำเร็จ ลองอีกครั้ง');
  };
  return (
    <section className="cv-pop cv-pop--machine cv-chrome" data-chrome="1" role="dialog" aria-label="เพิ่มเครื่อง" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <header className="cv-pop-head">
        <span className="cv-pop-title">เพิ่มเครื่อง</span>
        <button type="button" className="cv-pane-x" aria-label="ปิด" title="ปิด (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <MachineFormView initial={EMPTY_MACHINE_FORM} peers={peers} submitLabel="เพิ่มเครื่อง" busy={busy} error={error} onSubmit={(f) => void submit(f)} onCancel={onClose} />
    </section>
  );
}

export function Dot({ tone }: { tone: 'ok' | 'bad' | 'idle' }) {
  return <span className={`cv-sdot is-${tone}`} aria-hidden="true" />;
}

export const reachTone = (r: MachineInfo['reach']): 'ok' | 'bad' | 'idle' => (r === 'online' ? 'ok' : r === 'offline' ? 'bad' : 'idle');
export const sshTone = (s: MachineInfo['ssh']): 'ok' | 'bad' | 'idle' => (s === 'ok' ? 'ok' : s === 'fail' ? 'bad' : 'idle');

export interface MachineDrawerProps {
  machine: MachineInfo;
  attachments: MachineAttachment[];
  sessionName: (sessionId: string) => string;
  command: Command | undefined;
  onClose: () => void;
}

export function MachineDrawer({ machine, attachments, sessionName, command, onClose }: MachineDrawerProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // A different machine starts with a clean drawer.
  useEffect(() => {
    setEditing(false);
    setError(null);
    setTestNote(null);
    setArmed(false);
  }, [machine.id]);

  const mine = attachments.filter((a) => a.machineId === machine.id);

  const send = async (fn: (c: Command) => ReturnType<Command>): Promise<boolean> => {
    if (!command) {
      setError(offline);
      return false;
    }
    setBusy(true);
    setError(null);
    const r = await fn(command);
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'ทำไม่สำเร็จ ลองอีกครั้ง');
    return r.ok;
  };

  const test = async () => {
    setTestNote(null);
    const ok = await send((c) => c({ type: 'machine_test', machineId: machine.id }));
    if (ok) setTestNote('ทดสอบเสร็จแล้ว');
  };
  const del = async () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), CONFIRM_MS);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    if (await send((c) => c({ type: 'machine_delete', machineId: machine.id }))) onClose();
    else setArmed(false);
  };

  return (
    <aside className="cv-drawer cv-drawer--machine" data-chrome="1" data-drawer="1" role="complementary" aria-label={`เครื่อง ${machine.name}`} style={{ width: 400, ['--slide' as string]: '200ms' }}>
      <header className="cv-drawer-head">
        <Dot tone={reachTone(machine.reach)} />
        <span className="cv-pane-name">{machine.name}</span>
        <span className="cv-msub">{REACH_WORD[machine.reach]}</span>
        <button type="button" className="cv-pane-x" aria-label="ปิดช่อง" title="ปิด (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="cv-drawer-body cv-mbody">
        {editing ? (
          <MachineFormView
            initial={formFromMachine(machine)}
            submitLabel="บันทึก"
            busy={busy}
            error={error}
            onCancel={() => {
              setEditing(false);
              setError(null);
            }}
            onSubmit={async (f) => {
              if (await send((c) => c({ type: 'machine_update', machineId: machine.id, ...formPayload(f) }))) setEditing(false);
            }}
          />
        ) : (
          <>
            <dl className="cv-kv">
              <dt>ที่อยู่</dt>
              <dd className="is-mono">{machine.host}</dd>
              <dt>ผู้ใช้</dt>
              <dd className="is-mono">{machine.user}</dd>
              <dt>ไฟล์คีย์</dt>
              <dd className="is-mono">{machine.keyPath ? shortKeyPath(machine.keyPath) : 'ยังไม่ได้ตั้ง'}</dd>
              <dt>Shell</dt>
              <dd className="is-mono">{machine.shell}</dd>
              <dt>การเชื่อมต่อ</dt>
              <dd>
                <Dot tone={sshTone(machine.ssh)} /> {SSH_WORD[machine.ssh]}
                {machine.lastCheck ? ` · เช็คล่าสุด ${new Date(machine.lastCheck).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : ''}
              </dd>
              {machine.notes && (
                <>
                  <dt>บันทึก</dt>
                  <dd>{machine.notes}</dd>
                </>
              )}
            </dl>
            {machine.ssh === 'fail' && machine.sshError && (
              <div className="cn-error" role="alert">
                {machine.sshError}
              </div>
            )}
            <div className="cc-row">
              <button type="button" className="cc-btn is-primary" disabled={busy} onClick={() => void test()}>
                {busy && !armed ? 'กำลังทดสอบ…' : 'ทดสอบการเชื่อมต่อ'}
              </button>
              <button type="button" className="cc-btn" disabled={busy} onClick={() => setEditing(true)}>
                แก้ไข
              </button>
              <button type="button" className={`cc-btn${armed ? ' is-danger' : ''}`} disabled={busy} onClick={() => void del()}>
                {armed ? 'กดอีกครั้งเพื่อลบเครื่อง' : 'ลบเครื่อง'}
              </button>
            </div>
            {testNote && !error && <div className="cc-muted" role="status">{testNote}</div>}
            {error && (
              <div className="cn-error" role="alert">
                {error}
              </div>
            )}
            <div className="cv-msec">
              <div className="cv-fly-title">งานที่ต่อกับเครื่องนี้</div>
              {mine.length === 0 ? (
                <div className="cc-muted">ยังไม่มี — ลากเส้นจากจุดขวาของบล็อก AI มาวางที่เครื่องนี้</div>
              ) : (
                <ul className="cv-mlist">
                  {mine.map((a) => (
                    <li key={a.sessionId}>{sessionName(a.sessionId)}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="cv-msec">
              <div className="cv-fly-title">ดู Claude บนเครื่องนี้</div>
              {machine.agent ? (
                <div className={machine.agentState === 'error' ? 'cn-error' : 'cc-muted'} role="status">
                  <Dot tone={machine.agentState === 'online' ? 'ok' : machine.agentState === 'error' ? 'bad' : 'idle'} /> {agentLine(machine)}
                </div>
              ) : (
                <div className="cc-muted">ปิดอยู่ — กด แก้ไข แล้วติ๊ก "ดู Claude บนเครื่องนี้" (ต้องติดตั้ง agent บนเครื่องนั้นก่อน: node scripts/install-remote.mjs {machine.id})</div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
