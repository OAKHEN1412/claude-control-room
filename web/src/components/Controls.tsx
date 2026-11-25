// Stage 2 controls shared by the pane and the full-screen chat: model/effort selects, pending
// permission/question items, quick chips, send box, stop and "ย้ายมาคุมจากเว็บ".
import { useCallback, useEffect, useState } from 'react';
import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  PERMISSION_MODES,
  QUICK_CHIPS,
  type PermissionMode,
  type EffortLevel,
  type PendingRequest,
  type RunnerState,
  type SessionInfo,
} from '../../../shared/protocol';
import type { CommandInput, CommandResult } from '../commands';
import {
  CLOSE_CONFIRM_MS,
  adoptDisabledReason,
  adoptHint,
  allAnswered,
  buildAnswers,
  canCloseJob,
  canOpenTerminal,
  closeClick,
  closeJobTitle,
  controlMode,
  disabledReason,
  effortValue,
  isPermissionMode,
  isQuickAsk,
  modeChoice,
  modeValue,
  modelValue,
  openTerminalLabel,
  openTerminalTitle,
  queueStrip,
  runnerLine,
  sendNowConfirmLabel,
  sendNowLabel,
  sendNowTitle,
  takeoverArmedLabel,
  takeoverGate,
  takeoverLabel,
  takeoverTitle,
  targetLabel,
  terminalHint,
  toggleChoice,
  type ControlMode,
} from '../control';
import { useT, type TKey } from '../i18n';
import { serverText } from '../i18n/serverMsg';
import { attachRemoteTitle, canSubmit } from '../attach';
import { AttachButton, AttachChips, DropOverlay } from './AttachBar';
import { useAttachments } from './useAttachments';
import './control.css';
import { Composer } from './Composer';

export type Command = (cmd: CommandInput) => Promise<CommandResult>;

/** Runs commands one at a time per control group and keeps the last error for display. */
export function useCommand(command: Command) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const run = useCallback(
    async (cmd: CommandInput): Promise<CommandResult> => {
      setWorking(true);
      const r = await command(cmd);
      setWorking(false);
      setError(r.ok ? null : (serverText(r) || t('panels.controls.errorDefault')));
      return r;
    },
    [command, t],
  );
  return { run, error, working, clearError: () => setError(null) };
}

export interface ControlProps {
  session: SessionInfo;
  runner: RunnerState | undefined;
  command: Command;
}

const PERMISSION_MODE_KEY: Record<PermissionMode, TKey> = {
  default: 'panels.controls.modeDefault',
  acceptEdits: 'panels.controls.modeAcceptEdits',
  plan: 'panels.controls.modePlan',
  bypassPermissions: 'panels.controls.modeBypass',
};

/**
 * "โหมด" select. `value` is the committed mode ('' = not controllable: shows a dash). Choosing bypassPermissions
 * does NOT call onCommit until the inline confirmation is accepted (second click on "ยืนยัน").
 */
export function PermissionModeField({
  id,
  value,
  onCommit,
  disabled,
  title,
  large,
}: {
  id?: string;
  value: PermissionMode | '';
  onCommit: (mode: PermissionMode, confirmed: boolean) => void;
  disabled?: boolean;
  title?: string;
  large?: boolean;
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const change = (raw: string) => {
    if (!isPermissionMode(raw)) return;
    const what = modeChoice(value, raw);
    if (what === 'none') {
      setAsking(false);
    } else if (what === 'confirm') {
      setAsking(true);
    } else {
      setAsking(false);
      onCommit(raw, false);
    }
  };
  return (
    <div className="cc-modefield" title={title}>
      <select
        id={id}
        aria-label={t('panels.controls.modeAria')}
        className={`cc-sel${large ? ' is-large' : ''}`}
        value={value}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
      >
        {value === '' && <option value="">—</option>}
        {PERMISSION_MODES.map((m) => (
          <option key={m} value={m}>
            {t(PERMISSION_MODE_KEY[m])}
          </option>
        ))}
      </select>
      {asking && (
        <div className="cc-bypass" role="alertdialog" aria-label={t('panels.controls.bypassConfirmAria')}>
          <span>{t('panels.controls.bypassConfirm')}</span>
          <span className="cc-row">
            <button
              type="button"
              className="cc-btn is-danger"
              onClick={() => {
                setAsking(false);
                onCommit('bypassPermissions', true);
              }}
            >
              {t('panels.controls.confirm')}
            </button>
            <button type="button" className="cc-btn" onClick={() => setAsking(false)}>
              {t('panels.controls.cancel')}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/** "RC" = Remote Control (continue the job from claude.ai / phone). */
export function RemoteToggle({
  id,
  on,
  onChange,
  disabled,
  title,
}: {
  id?: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  const t = useT();
  return (
    <label className={`cc-rc${on ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`} title={title ?? t('panels.controls.rcTitle')}>
      <input id={id} type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>RC</span>
    </label>
  );
}

export function ModelEffort({ session, runner, command, large }: ControlProps & { large?: boolean }) {
  const t = useT();
  const mode = controlMode(session, runner);
  const reason = disabledReason(mode);
  const { run, error, working } = useCommand(command);
  const model = modelValue(runner, session);
  const effort = effortValue(runner, session);
  const cls = `cc-sel${large ? ' is-large' : ''}`;
  return (
    <div className="cc-modeleffort">
      <div className="cc-selrow" title={reason ?? undefined}>
        <select
          aria-label={t('panels.controls.modelAria')}
          className={cls}
          style={{ flex: 2 }}
          value={model}
          disabled={mode !== 'runner' || working}
          onChange={(e) => void run({ type: 'set_model', sessionId: session.sessionId, model: e.target.value })}
        >
          {model === '' && <option value="">{session.model ?? '—'}</option>}
          {MODEL_OPTIONS.map((o) => (
            <option key={o.id} value={o.id} disabled={!!o.disabled} title={o.disabled}>
              {o.disabled ? `${o.label} (${o.disabled})` : o.label}
            </option>
          ))}
        </select>
        <select
          aria-label={t('panels.controls.effortAria')}
          className={cls}
          style={{ flex: 1 }}
          value={EFFORT_LEVELS.includes(effort as EffortLevel) ? effort : ''}
          disabled={mode !== 'runner' || working}
          onChange={(e) => void run({ type: 'set_effort', sessionId: session.sessionId, effort: e.target.value as EffortLevel })}
        >
          {!EFFORT_LEVELS.includes(effort as EffortLevel) && <option value="">{effort}</option>}
          {EFFORT_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="cc-selrow" title={reason ?? undefined}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PermissionModeField
            value={modeValue(runner)}
            large={large}
            disabled={mode !== 'runner' || working}
            onCommit={(m, confirmed) =>
              void run({ type: 'set_permission_mode', sessionId: session.sessionId, mode: m, ...(confirmed ? { confirm: true } : {}) })
            }
          />
        </div>
        <RemoteToggle
          on={runner?.alive === true && runner.remoteControl}
          disabled={mode !== 'runner' || working}
          onChange={(on) => void run({ type: 'set_remote_control', sessionId: session.sessionId, on })}
          title={runner?.remoteUrl ? t('panels.controls.rcOnTitle', { url: runner.remoteUrl }) : undefined}
        />
      </div>
      {(runner || mode === 'readonly') && (
        <div className="cc-badge" role="status">
          {runner && (
            <span className={runner.confirmed ? 'cc-ok' : 'cc-muted'}>{runner.confirmed ? t('panels.controls.confirmedByJob') : t('panels.controls.waitingJob')}</span>
          )}
          {!runner && mode === 'readonly' && <span className="cc-muted">{reason}</span>}
        </div>
      )}
      {error && (
        <div className="cc-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function PendingCard({ session, p, command }: { session: SessionInfo; p: PendingRequest; command: Command }) {
  const t = useT();
  const { run, error, working } = useCommand(command);
  const [choices, setChoices] = useState<Record<string, string[] | string>>({});
  const [free, setFree] = useState('');
  const answer = (behavior: 'allow' | 'deny', answers?: Record<string, string>) =>
    void run({ type: 'answer', sessionId: session.sessionId, requestId: p.requestId, behavior, answers });

  if (p.kind === 'ask' && p.questions) {
    const qs = p.questions;
    const quick = isQuickAsk(p);
    return (
      <section className="cc-pending is-ask" aria-label={t('panels.controls.askAria')}>
        <div className="cc-pend-title">{t('panels.controls.askTitle', { target: targetLabel(session) })}</div>
        {qs.map((q) => {
          const cur = choices[q.question];
          return (
            <div key={q.question} className="cc-q">
              <div className="cc-q-text">{q.question}</div>
              {q.multiSelect && <div className="cc-muted">{t('panels.controls.multiHint')}</div>}
              <div className="cc-opts">
                {q.options.map((o) => {
                  const on = Array.isArray(cur) ? cur.includes(o.label) : cur === o.label;
                  return (
                    <button
                      key={o.label}
                      type="button"
                      className={`cc-opt${on ? ' is-on' : ''}`}
                      disabled={working}
                      title={o.description}
                      aria-pressed={quick ? undefined : on}
                      onClick={() => {
                        if (quick) answer('allow', buildAnswers(qs, { [q.question]: o.label }));
                        else setChoices((c) => toggleChoice(c, q, o.label));
                      }}
                    >
                      {o.label}
                      {o.description && <span className="cc-opt-desc">{o.description}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="cc-row">
          <input
            aria-label={t('panels.controls.freeAria')}
            className="cc-input"
            value={free}
            placeholder={t('panels.controls.freePlaceholder')}
            onChange={(e) => setFree(e.target.value)}
          />
          <button
            type="button"
            className="cc-btn is-accent"
            disabled={working || (qs.length === 1 ? free.trim() === '' && !allAnswered(qs, choices) : !allAnswered(qs, choices))}
            onClick={() => {
              const merged: Record<string, string[] | string> = { ...choices };
              if (qs.length === 1 && free.trim() !== '') merged[qs[0].question] = free.trim();
              answer('allow', buildAnswers(qs, merged));
            }}
          >
            {t('panels.controls.answer')}
          </button>
          <button type="button" className="cc-btn" disabled={working} onClick={() => answer('deny')}>
            {t('panels.controls.skip')}
          </button>
        </div>
        {error && <div className="cc-error">{error}</div>}
      </section>
    );
  }

  return (
    <section className="cc-pending" aria-label={t('panels.controls.toolAria')}>
      <div className="cc-pend-title">
        {t('panels.controls.toolRequest')} · <b className="cc-mono">{p.toolName}</b> · {targetLabel(session)}
      </div>
      <div className="cc-pend-desc">{p.description}</div>
      <pre className="cc-pend-input">{p.inputPreview}</pre>
      <div className="cc-row">
        <button type="button" className="cc-btn is-accent" disabled={working} onClick={() => answer('allow')}>
          {t('panels.controls.allow')}
        </button>
        <button type="button" className="cc-btn" disabled={working} onClick={() => answer('deny')}>
          {t('panels.controls.deny')}
        </button>
      </div>
      {error && <div className="cc-error">{error}</div>}
    </section>
  );
}

export function PendingList({ session, runner, command }: ControlProps) {
  if (!runner || runner.pending.length === 0) return null;
  return (
    <div className="cc-pendlist">
      {runner.pending.map((p) => (
        <PendingCard key={p.requestId} session={session} p={p} command={command} />
      ))}
    </div>
  );
}

/** The rest of the send box for the canvas pane's rail: run line, adopt button and quick chips. */
export function QuickPanel({ session, runner, command }: ControlProps) {
  const t = useT();
  const mode: ControlMode = controlMode(session, runner);
  const reason = disabledReason(mode);
  const { run, error, working } = useCommand(command);
  const can = mode === 'runner';
  const target = targetLabel(session);
  return (
    <div className="cc-quick">
      {runner && <div className="cc-runline" role="status">{runnerLine(runner)}</div>}
      {mode !== 'runner' && (
        <div className="cc-adopt">
          {mode === 'readonly' ? (
            <TakeoverButton session={session} mode={mode} run={run} working={working} />
          ) : (
            <button
              type="button"
              className="cc-btn is-primary"
              disabled={mode !== 'adoptable' || working}
              title={mode === 'adoptable' ? adoptHint() : adoptDisabledReason()}
              onClick={() => void run({ type: 'adopt', sessionId: session.sessionId })}
            >
              {t('panels.controls.moveToWeb')}
            </button>
          )}
          <span className="cc-muted">{mode === 'adoptable' ? adoptHint() : (terminalHint(mode, session.sessionId) ?? adoptDisabledReason())}</span>
        </div>
      )}
      {can && (
        <div className="cc-adopt">
          <button type="button" className="cc-btn" disabled={working} title={openTerminalTitle()} onClick={() => void run({ type: 'open_terminal', sessionId: session.sessionId })}>
            {openTerminalLabel()}
          </button>
        </div>
      )}
      <div className="cc-chips">
        {QUICK_CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            className="cc-chip"
            disabled={!can || working}
            title={can ? t('panels.controls.targetTitle', { target }) : (reason ?? undefined)}
            onClick={() => void run({ type: 'send', sessionId: session.sessionId, text: c })}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="cc-target" title={session.cwd}>
        {t('panels.controls.target')}: <b>{target}</b>
      </div>
      {error && (
        <div className="cc-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Stop and close (two-click confirm) as plain state, so the pane's rail can draw them as icon buttons. */
export function useJobButtons({ session, runner, command }: ControlProps) {
  const t = useT();
  const mode: ControlMode = controlMode(session, runner);
  const reason = disabledReason(mode);
  const { run, error, working } = useCommand(command);
  const can = mode === 'runner';
  const canClose = canCloseJob(mode);
  const close = useCloseArm(canClose, () => void run({ type: 'close', sessionId: session.sessionId }));
  const gate = takeoverGate(session, mode);
  const takeover = useCloseArm(gate.enabled, () => void run({ type: 'takeover', sessionId: session.sessionId }));
  return {
    error,
    takeover: {
      visible: mode === 'readonly',
      armed: takeover.armed,
      disabled: !gate.enabled || working,
      title: takeover.armed ? takeoverArmedLabel() : gate.enabled ? `${takeoverLabel()} — ${takeoverTitle()}` : `${takeoverLabel()} — ${gate.title}`,
      onClick: takeover.click,
    },
    terminal: {
      disabled: !canOpenTerminal(mode) || working,
      title: canOpenTerminal(mode) ? openTerminalTitle() : t('panels.controls.openTerminalWebOnly'),
      onClick: () => void run({ type: 'open_terminal', sessionId: session.sessionId }),
    },
    stop: {
      disabled: !can || !runner?.busy,
      title: can ? t('panels.controls.stopTitle') : (reason ?? t('panels.controls.stopImpossible')),
      onClick: () => void run({ type: 'stop', sessionId: session.sessionId }),
    },
    close: {
      armed: close.armed,
      disabled: !canClose || working,
      title: closeJobTitle(mode),
      onClick: close.click,
    },
  };
}

/** "ยึดมาคุม": two-click button for a live terminal session; the server closes that claude and adopts the session. */
export function TakeoverButton({ session, mode, run, working }: { session: SessionInfo; mode: ControlMode; run: (cmd: CommandInput) => Promise<CommandResult>; working: boolean }) {
  useT(); // labels below are read at render: subscribe to language changes
  const gate = takeoverGate(session, mode);
  const arm = useCloseArm(gate.enabled, () => void run({ type: 'takeover', sessionId: session.sessionId }));
  return (
    <button
      type="button"
      className={`cc-btn is-primary${arm.armed ? ' is-danger' : ''}`}
      disabled={!gate.enabled || working}
      title={arm.armed ? takeoverArmedLabel() : gate.title}
      onClick={arm.click}
    >
      {arm.armed ? takeoverArmedLabel() : takeoverLabel()}
    </button>
  );
}

/**
 * Two-click close: the first click arms the button for CLOSE_CONFIRM_MS; a second click inside that time calls `onSend`.
 */
export function useCloseArm(canClose: boolean, onSend: () => void) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CLOSE_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const click = () => {
    const step = closeClick(armed, canClose);
    if (step === 'arm') setArmed(true);
    if (step === 'send') {
      setArmed(false);
      onSend();
    }
  };
  return { armed, click };
}

/** "ข้อความรอส่ง N" above the send box: what is waiting behind the running command, and a two-click "stop and send now". */
function QueueStrip({ session, runner, run, working }: { session: SessionInfo; runner: RunnerState | undefined; run: (c: CommandInput) => Promise<CommandResult>; working: boolean }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const strip = queueStrip(session, runner, now);
  useEffect(() => {
    if (!strip) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [strip?.count, strip?.running === null]);
  const { armed, click } = useCloseArm(!!strip && !working, () => void run({ type: 'send_now', sessionId: session.sessionId }));
  if (!strip) return null;
  return (
    <div className="cc-queue" role="status">
      <div className="cc-queue-head">
        <b>{strip.headline}</b>
        {strip.texts.length > 0 && (
          <button type="button" className="cc-link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t('panels.controls.queueHide') : t('panels.controls.queueShow')}
          </button>
        )}
        <button type="button" className={`cc-btn${armed ? ' is-danger' : ''}`} disabled={working} title={sendNowTitle()} onClick={click}>
          {armed ? sendNowConfirmLabel() : sendNowLabel()}
        </button>
      </div>
      {strip.running && <div className="cc-muted cc-queue-run">{t('panels.controls.queueRunning', { running: strip.running })}</div>}
      {armed && <div className="cc-muted cc-queue-warn">{t('panels.controls.queueWarn')}</div>}
      {open && strip.texts.length > 0 && (
        <ol className="cc-queue-list">
          {strip.texts.map((q, i) => (
            <li key={`${q.at}-${i}`}>
              {q.text}
              {q.files && q.files.length > 0 ? <span className="cc-muted">{t('panels.controls.queueAttached', { files: q.files.join(', ') })}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The send box with its quick chips, stop and close. `compact` keeps only the send box (and its error):
 * the canvas pane moves the rest into its side rail (QuickPanel, useJobButtons).
 */
export function Compose({ session, runner, command, large, compact }: ControlProps & { large?: boolean; compact?: boolean }) {
  const t = useT();
  const mode: ControlMode = controlMode(session, runner);
  const reason = disabledReason(mode);
  const { run, error, working } = useCommand(command);
  const [draft, setDraft] = useState('');
  const canClose = canCloseJob(mode);
  const { armed: closeArmed, click: onClose } = useCloseArm(canClose, () => void run({ type: 'close', sessionId: session.sessionId }));
  const can = mode === 'runner';
  // A job on another machine (machineId, set by the remote-machines branch) cannot read files saved on this PC.
  const remote = !!((session as { machineId?: string }).machineId || (runner as { machineId?: string } | undefined)?.machineId);
  const att = useAttachments({ disabledReason: !can ? reason : remote ? attachRemoteTitle() : null });
  const send = (text: string, withFiles = true) => {
    const files = withFiles ? att.ids : [];
    if (!can || att.uploading || (text.trim() === '' && files.length === 0)) return;
    void run({ type: 'send', sessionId: session.sessionId, text, ...(files.length > 0 ? { attachments: files } : {}) }).then((r) => {
      if (!r.ok) return;
      if (text === draft) setDraft('');
      if (files.length > 0) att.clear();
    });
  };
  const target = targetLabel(session);
  return (
    <div className="cc-compose" ref={att.bindHost}>
      <DropOverlay att={att} />
      {!compact && runner && <div className="cc-runline" role="status">{runnerLine(runner)}</div>}
      {!compact && mode !== 'runner' && (
        <div className="cc-adopt">
          {mode === 'readonly' ? (
            <TakeoverButton session={session} mode={mode} run={run} working={working} />
          ) : (
            <button
              type="button"
              className="cc-btn is-primary"
              disabled={mode !== 'adoptable' || working}
              title={mode === 'adoptable' ? adoptHint() : adoptDisabledReason()}
              onClick={() => void run({ type: 'adopt', sessionId: session.sessionId })}
            >
              {t('panels.controls.moveToWeb')}
            </button>
          )}
          <span className="cc-muted">{mode === 'adoptable' ? adoptHint() : (terminalHint(mode, session.sessionId) ?? adoptDisabledReason())}</span>
        </div>
      )}
      {compact && terminalHint(mode, session.sessionId) && (
        <div className="cc-muted cc-termhint" role="note">
          {terminalHint(mode, session.sessionId)}
        </div>
      )}
      {!compact && (
        <div className="cc-chips">
          {QUICK_CHIPS.map((c) => (
            <button key={c} type="button" className="cc-chip" disabled={!can || working} title={can ? t('panels.controls.targetTitle', { target }) : (reason ?? undefined)} onClick={() => send(c, false)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <QueueStrip session={session} runner={runner} run={run} working={working} />
      <AttachChips att={att} />
      <div className="cc-row">
        <Composer
          aria-label={t('panels.controls.composeAria')}
          large={large}
          sessionId={session.sessionId}
          value={draft}
          disabled={!can}
          title={can ? undefined : (reason ?? undefined)}
          placeholder={can ? t('panels.controls.composePlaceholder') : t('panels.controls.composeOffPlaceholder')}
          onChange={setDraft}
          onPaste={att.onPaste}
          onSubmit={() => send(draft)}
        />
        <AttachButton att={att} off={!can} />
        <button type="button" className="cc-btn is-primary" disabled={!can || working || !canSubmit(draft, att.chips)} onClick={() => send(draft)}>
          {t('panels.controls.send')}
        </button>
        {!compact && (
          <>
            <button
              type="button"
              className="cc-btn"
              disabled={!can || !runner?.busy}
              title={can ? t('panels.controls.stopTitle') : (reason ?? undefined)}
              onClick={() => void run({ type: 'stop', sessionId: session.sessionId })}
            >
              {t('panels.controls.stop')}
            </button>
            {can && (
              <button type="button" className="cc-btn" disabled={working} title={openTerminalTitle()} onClick={() => void run({ type: 'open_terminal', sessionId: session.sessionId })}>
                {openTerminalLabel()}
              </button>
            )}
            <button
              type="button"
              className={`cc-btn${closeArmed ? ' is-danger' : ''}`}
              disabled={!canClose || working}
              title={closeJobTitle(mode)}
              onClick={onClose}
            >
              {closeArmed ? t('panels.controls.closeConfirm') : t('panels.controls.closeJob')}
            </button>
          </>
        )}
      </div>
      {!compact && (
        <div className="cc-target" title={session.cwd}>
          {t('panels.controls.target')}: <b>{target}</b>
        </div>
      )}
      {error && (
        <div className="cc-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
