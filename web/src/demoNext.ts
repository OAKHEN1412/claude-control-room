// ?demo=1 data of round 3: relay links, saved sessions, machines. Kept apart from demo.ts (sessions).
import type { LinkInfo, SessionInfo } from '../../shared/protocol';
import type { MachineAttachment, MachineInfo, SavedSession, TailscalePeer } from './protocolNext';

/** Relay links in every state, including an A <-> B pair (portfolio / pc-hands). */
export function demoLinks(now: number, sessions: SessionInfo[]): LinkInfo[] {
  const has = (id: string) => sessions.some((s) => s.sessionId === id);
  if (!has('demo-portfolio') || !has('demo-pchands') || !has('demo-shop')) return [];
  return [
    { id: 'l1', from: 'demo-portfolio', to: 'demo-pchands', paused: false, state: 'ok', forwards: 2, maxForwards: 6, lastForwardAt: now - 30_000 },
    { id: 'l2', from: 'demo-pchands', to: 'demo-portfolio', paused: false, state: 'limit', forwards: 6, maxForwards: 6, lastForwardAt: now - 90_000 },
    { id: 'l3', from: 'demo-portfolio', to: 'demo-shop', paused: true, state: 'ok', forwards: 1, maxForwards: 6, lastForwardAt: now - 300_000 },
    { id: 'l4', from: 'demo-shop', to: 'demo-pchands', paused: false, state: 'error', forwards: 3, maxForwards: 10, lastForwardAt: now - 60_000, error: 'ส่งต่อไม่สำเร็จ: งานปลายทางกำลังตอบอยู่' },
    { id: 'l5', from: 'demo-pchands', to: 'demo-shop', paused: false, state: 'rate', forwards: 4, maxForwards: 6, lastForwardAt: now - 45_000, error: 'ส่งถี่เกินไป' },
  ];
}

/** Saved sessions: live ones, older web / terminal / clip jobs, and two hidden ones for the trash tab. */
export function demoSaved(now: number, sessions: SessionInfo[]): SavedSession[] {
  const h = 3_600_000;
  const d = 24 * h;
  const live = new Set(sessions.map((s) => s.sessionId));
  const row = (
    sessionId: string,
    title: string,
    cwd: string,
    model: string | null,
    effort: string | null,
    source: SavedSession['source'],
    ago: number,
    hidden = false,
  ): SavedSession => ({
    sessionId,
    title,
    cwd,
    model,
    effort,
    source,
    firstSeen: now - ago - 2 * h,
    lastActivity: now - ago,
    hidden,
    live: live.has(sessionId),
  });
  return [
    row('demo-portfolio', 'ปรับหน้า portfolio', 'C:\\Users\\Demo\\portfolio', 'opus', 'high', 'terminal', 20_000),
    row('demo-pchands', 'วัดผล pc-hands เทียบของเดิม', 'C:\\Users\\Demo\\pc-hands', 'sonnet', 'medium', 'web', 4_000),
    row('demo-shop', 'ปรับตะกร้าและหน้าชำระเงิน', 'C:\\Users\\Demo\\webshop', 'claude-opus-5-5', 'xhigh', 'terminal', 1_500),
    row('old-seo', 'เขียนบทความ SEO หมวดกระบอกลม', 'C:\\Users\\Demo\\wp-seo-tool', 'sonnet', 'medium', 'web', 5 * h),
    row('old-clip', 'คลิปแนะนำ FRL unit', 'C:\\Users\\Demo\\videos\\frl-unit', 'opus', 'high', 'clip', 9 * h),
    row('old-plc', 'ไล่ bug ladder ของ PLC', 'C:\\Users\\Demo\\plc-panel', 'opus', 'xhigh', 'terminal', d + 2 * h),
    row('old-pcb', 'ตรวจ DRC บอร์ด v2', 'C:\\Users\\Demo\\board-v2', 'sonnet', 'high', 'web', d + 6 * h),
    row('old-quote', 'ทำใบเสนอราคาลูกค้า', 'C:\\Users\\Demo\\quotes', 'haiku', null, 'web', 3 * d),
    row('old-trash1', 'ทดลอง prompt ภาพประกอบ', 'C:\\Users\\Demo\\scratch', 'haiku', 'low', 'web', 2 * d, true),
    row('old-trash2', 'สำรวจ API ตู้ขายของ', 'C:\\Users\\Demo\\kiosk', 'sonnet', 'medium', 'terminal', 4 * d, true),
  ];
}

export function demoMachines(
  now: number,
  sessions: SessionInfo[],
): { machines: MachineInfo[]; attachments: MachineAttachment[]; peers: TailscalePeer[] } {
  const machines: MachineInfo[] = [
    { id: 'm-server', name: 'desktop-server', host: '100.88.12.4', user: 'admin', keyPath: '~/.ssh/id_ed25519', shell: 'cmd', notes: 'เครื่องเซิร์ฟเวอร์ที่สำนักงาน (Express, LINE bot)', reach: 'online', ssh: 'ok', lastCheck: now - 120_000 },
    { id: 'm-sales2', name: 'desktop-sales2', host: '100.88.40.9', user: 'sales', keyPath: '', shell: 'powershell', notes: '', reach: 'offline', ssh: 'not_configured', lastCheck: null },
  ];
  const shop = sessions.some((s) => s.sessionId === 'demo-shop');
  const attachments: MachineAttachment[] = shop ? [{ sessionId: 'demo-shop', machineId: 'm-server', at: now - 600_000 }] : [];
  const peers: TailscalePeer[] = [
    { name: 'desktop-server', ip: '100.88.12.4', os: 'windows', online: true },
    { name: 'desktop-sales2', ip: '100.88.40.9', os: 'windows', online: false },
    { name: 'laptop-office', ip: '100.88.7.21', os: 'windows', online: true },
    { name: 'oak-phone', ip: '100.88.3.2', os: 'android', online: true },
  ];
  return { machines, attachments, peers };
}
