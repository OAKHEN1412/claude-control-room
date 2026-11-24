// Stage 3 notifications: browser Notification API + an optional short sound. Both are best-effort and
// never throw (a blocked API simply does nothing).
import { notificationText, type QueueItem } from './queue';

export type NotifyPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export function notifyPermission(): NotifyPermission {
  try {
    return typeof Notification === 'undefined' ? 'unsupported' : (Notification.permission as NotifyPermission);
  } catch {
    return 'unsupported';
  }
}

/** Must be called from a click handler (the browser only prompts after a user gesture). */
export async function askNotifyPermission(): Promise<NotifyPermission> {
  try {
    if (typeof Notification === 'undefined') return 'unsupported';
    await Notification.requestPermission();
  } catch {
    // ignore
  }
  return notifyPermission();
}

/** Shows one notification; clicking it focuses the tab and calls onOpen. Returns true when shown. */
export function showNotification(it: QueueItem, onOpen: (key: string) => void): boolean {
  if (notifyPermission() !== 'granted') return false;
  try {
    const { title, body } = notificationText(it);
    const n = new Notification(title, { body, tag: it.key, requireInteraction: false });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore
      }
      onOpen(it.key);
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

let audio: AudioContext | null = null;

/** Short two-tone beep. */
export function playBeep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    const ctx = audio;
    void ctx.resume();
    const t0 = ctx.currentTime;
    [880, 1175].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.15, t0 + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.11);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + i * 0.12);
      o.stop(t0 + i * 0.12 + 0.12);
    });
  } catch {
    // ignore
  }
}

const SOUND_KEY = 'cr.sound';
export function loadSound(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}
export function saveSound(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}
