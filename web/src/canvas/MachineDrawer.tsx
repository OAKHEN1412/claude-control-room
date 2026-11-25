// Machine popover ("+ เครื่อง") and the machine drawer (details, edit, connection test, delete).
import { useEffect, useRef, useState } from 'react';
import type { Command } from '../components/Controls';
import { getLanguage, useT } from '../i18n';
import { serverText } from '../i18n/serverMsg';
import { EMPTY_MACHINE_FORM, REACH_WORD, agentLine, SSH_WORD, formFromMachine, formPayload, shortKeyPath, type MachineForm } from '../machineForm';
import type { MachineAttachment, MachineInfo, TailscalePeer } from '../protocolNext';
import { CloseIcon } from './icons';
import { MachineFormView } from './MachineFormView';

const CONFIRM_MS = 4000;

export function MachineAddPopover({ peers, command, onAdded, onClose }: { peers: TailscalePeer[]; command: Command | undefined; onAdded: (machineId: string | undefined) => void; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (f: MachineForm) => {
    if (!command) {
      setError(t('machine.drawer.offline'));
      return;
    }
    setBusy(true);
    setError(null);
    const r = await command({ type: 'machine_add', ...formPayload(f) });
    setBusy(false);
    if (r.ok) onAdded(r.machineId);
    else setError(serverText(r) || t('machine.drawer.failed'));
  };
  return (
    <section className="cv-pop cv-pop--machine cv-chrome" data-chrome="1" role="dialog" aria-label={t('machine.drawer.addTitle')} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <header className="cv-pop-head">
        <span className="cv-pop-title">{t('machine.drawer.addTitle')}</span>
        <button type="button" className="cv-pane-x" aria-label={t('machine.drawer.close')} title={t('machine.drawer.closeEsc')} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <MachineFormView initial={EMPTY_MACHINE_FORM} peers={peers} submitLabel={t('machine.drawer.addTitle')} busy={busy} error={error} onSubmit={(f) => void submit(f)} onCancel={onClose} />
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
  const t = useT();
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
      setError(t('machine.drawer.offline'));
      return false;
    }
    setBusy(true);
    setError(null);
    const r = await fn(command);
    setBusy(false);
    if (!r.ok) setError(serverText(r) || t('machine.drawer.failed'));
    return r.ok;
  };

  const test = async () => {
    setTestNote(null);
    const ok = await send((c) => c({ type: 'machine_test', machineId: machine.id }));
    if (ok) setTestNote(t('machine.drawer.testDone'));
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

  const locale = getLanguage() === 'th' ? 'th-TH' : 'en-US';

  return (
    <aside className="cv-drawer cv-drawer--machine" data-chrome="1" data-drawer="1" role="complementary" aria-label={t('machine.drawer.ariaLabel', { name: machine.name })} style={{ width: 400, ['--slide' as string]: '200ms' }}>
      <header className="cv-drawer-head">
        <Dot tone={reachTone(machine.reach)} />
        <span className="cv-pane-name">{machine.name}</span>
        <span className="cv-msub">{REACH_WORD[machine.reach]}</span>
        <button type="button" className="cv-pane-x" aria-label={t('machine.drawer.closePane')} title={t('machine.drawer.closeEsc')} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="cv-drawer-body cv-mbody">
        {editing ? (
          <MachineFormView
            initial={formFromMachine(machine)}
            submitLabel={t('machine.drawer.save')}
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
              <dt>{t('machine.drawer.address')}</dt>
              <dd className="is-mono">{machine.host}</dd>
              <dt>{t('machine.drawer.user')}</dt>
              <dd className="is-mono">{machine.user}</dd>
              <dt>{t('machine.drawer.keyFile')}</dt>
              <dd className="is-mono">{machine.keyPath ? shortKeyPath(machine.keyPath) : t('machine.drawer.keyNotSet')}</dd>
              <dt>Shell</dt>
              <dd className="is-mono">{machine.shell}</dd>
              <dt>{t('machine.drawer.connection')}</dt>
              <dd>
                <Dot tone={sshTone(machine.ssh)} /> {SSH_WORD[machine.ssh]}
                {machine.lastCheck ? t('machine.drawer.lastCheck', { time: new Date(machine.lastCheck).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) }) : ''}
              </dd>
              {machine.notes && (
                <>
                  <dt>{t('machine.drawer.notes')}</dt>
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
                {busy && !armed ? t('machine.drawer.testing') : t('machine.drawer.test')}
              </button>
              <button type="button" className="cc-btn" disabled={busy} onClick={() => setEditing(true)}>
                {t('machine.drawer.edit')}
              </button>
              <button type="button" className={`cc-btn${armed ? ' is-danger' : ''}`} disabled={busy} onClick={() => void del()}>
                {armed ? t('machine.drawer.deleteArmed') : t('machine.drawer.delete')}
              </button>
            </div>
            {testNote && !error && <div className="cc-muted" role="status">{testNote}</div>}
            {error && (
              <div className="cn-error" role="alert">
                {error}
              </div>
            )}
            <div className="cv-msec">
              <div className="cv-fly-title">{t('machine.drawer.jobsTitle')}</div>
              {mine.length === 0 ? (
                <div className="cc-muted">{t('machine.drawer.noJobs')}</div>
              ) : (
                <ul className="cv-mlist">
                  {mine.map((a) => (
                    <li key={a.sessionId}>{sessionName(a.sessionId)}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="cv-msec">
              <div className="cv-fly-title">{t('machine.drawer.agentTitle')}</div>
              {machine.agent ? (
                <div className={machine.agentState === 'error' ? 'cn-error' : 'cc-muted'} role="status">
                  <Dot tone={machine.agentState === 'online' ? 'ok' : machine.agentState === 'error' ? 'bad' : 'idle'} /> {agentLine(machine)}
                </div>
              ) : (
                <div className="cc-muted">{t('machine.drawer.agentOff', { id: machine.id })}</div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
