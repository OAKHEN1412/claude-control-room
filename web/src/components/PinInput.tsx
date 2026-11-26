// Six masked boxes for the app PIN. The digits live only in this component's state; the parent gets the PIN
// through onComplete (fired once, when the 6th digit is entered or a paste fills all six) and clears the boxes by
// bumping resetKey. error=true shakes the boxes and clears them.
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactElement } from 'react';
import { useT } from '../i18n';
import { PIN_LEN, backspace, emptyPin, isComplete, lockoutRemaining, paste, toPin, typeDigit, type PinState, type PinStep } from '../pinLogic';
import './unlock.css';

export interface PinInputProps {
  value?: PinState; // initial digits (the app never needs them; kept for callers that pre-fill)
  onComplete(pin: string): void;
  disabled?: boolean;
  error?: boolean;
  label: string;
  autoFocus?: boolean;
  onChange?(): void;
  resetKey?: number;
  /** Extra class on the group (e.g. pin-group--center). */
  className?: string;
  /** Focus the first box when resetKey changes. Off by default: a finished form must not pull focus. */
  focusOnReset?: boolean;
}

const SHAKE_MS = 450;

export function PinInput(props: PinInputProps): ReactElement {
  const t = useT();
  const [cells, setCells] = useState<PinState>(() => props.value ?? emptyPin());
  const [shaking, setShaking] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const resetSeen = useRef(props.resetKey);

  const focusAt = (i: number): void => {
    refs.current[i]?.focus();
  };

  // Focus the first box when the parent asks for it (a later step of a multi-row form).
  useEffect(() => {
    if (props.autoFocus) focusAt(0);
  }, [props.autoFocus]);

  // The parent bumps resetKey after a finished call: clear the boxes. Not on mount.
  useEffect(() => {
    if (resetSeen.current === props.resetKey) return;
    resetSeen.current = props.resetKey;
    setCells(emptyPin());
    if (props.focusOnReset) focusAt(0);
  }, [props.resetKey]);

  // A wrong PIN: shake, clear and start again at the first box.
  useEffect(() => {
    if (!props.error) return;
    setCells(emptyPin());
    setShaking(true);
    focusAt(0);
    const timer = setTimeout(() => setShaking(false), SHAKE_MS);
    return () => clearTimeout(timer);
  }, [props.error]);

  /** Applies a step: stores the cells, moves the focus, reports the change and completion. */
  const apply = (prev: PinState, step: PinStep, changed: boolean): void => {
    setCells(step.state);
    focusAt(step.focus);
    if (!changed) return;
    props.onChange?.();
    if (!isComplete(prev) && isComplete(step.state)) props.onComplete(toPin(step.state));
  };

  const onKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>): void => {
    if (props.disabled) return;
    if (e.key === 'Backspace') {
      e.preventDefault();
      apply(cells, backspace(cells, index), true);
      return;
    }
    if (e.key.length === 1 && /[0-9]/.test(e.key)) {
      e.preventDefault();
      const step = typeDigit(cells, index, e.key);
      apply(cells, step, true);
    }
    // Other keys (Tab, arrows, Enter) keep their normal behaviour.
  };

  // Mobile keyboards send no usable key codes; the input value then carries the digit or the deletion.
  const onInput = (index: number, value: string): void => {
    if (props.disabled) return;
    const digits = value.replace(/\D/g, '');
    if (digits.length === 0) {
      apply(cells, backspace(cells, index), cells[index] !== '');
      return;
    }
    apply(cells, typeDigit(cells, index, digits[digits.length - 1]), true);
  };

  const onPaste = (index: number, e: ClipboardEvent<HTMLInputElement>): void => {
    e.preventDefault();
    if (props.disabled) return;
    const text = e.clipboardData.getData('text');
    apply(cells, paste(cells, index, text), text.replace(/\D/g, '').length > 0);
  };

  const groupClass = ['pin-group', props.className ?? '', shaking ? 'is-shaking' : '', props.error ? 'is-error' : ''].filter(Boolean).join(' ');

  return (
    <div className={groupClass} role="group" aria-label={props.label}>
      {Array.from({ length: PIN_LEN }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="pin-box"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          autoComplete="off"
          aria-label={t('acct.pin.digit', { n: i + 1, total: PIN_LEN })}
          aria-invalid={props.error || undefined}
          value={cells[i]}
          disabled={props.disabled}
          onKeyDown={(e) => onKeyDown(i, e)}
          onChange={(e) => onInput(i, e.target.value)}
          onPaste={(e) => onPaste(i, e)}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

/**
 * Milliseconds left of a lockout that ends at `until` (a Date.now() timestamp), ticking once a second.
 * null = no lockout. Returns 0 when the lockout is over (the caller re-enables the boxes).
 */
export function useLockoutRemaining(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);
  return until === null ? 0 : lockoutRemaining(until, now);
}
