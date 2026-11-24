import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { LinkInfo, RunnerState, SessionInfo, Status } from '../../../shared/protocol';
import type { MachineAttachment, MachineInfo, TailscalePeer } from '../protocolNext';
import { modeBadges } from '../control';
import type { CharView } from '../useCharacter';
import { Character } from '../components/Character';
import { STATUS_WORD, badgeText, shortModel } from '../components/graphLayout';
import {
  CARD_H,
  CARD_W,
  CAPTION_GAP,
  CAPTION_H,
  MACHINE_KEY,
  SHAPE,
  allBoxes,
  applyPositions,
  canvasEdges,
  hCurve,
  unionBox,
  layoutCanvas,
  modelWord,
  type Box,
  type Point,
  type StoredPositions,
} from './canvasLayout';
import { limitText } from '../limit';
import { loadPositions, prunePositions, savePositions } from './canvasStore';
import type { Command } from '../components/Controls';
import { AgentIcon, BranchIcon, ClockIcon, CloseIcon, ComputerIcon, FitIcon, PaneAddIcon, RearrangeIcon } from './icons';
import { fitBoundsOf, liveOverride, persistAutoPlacement, placeMachines, relayoutPanes, resolvePanes, resolvePlacement, withMachines } from './placement';
import { CanvasPane } from './CanvasPane';
import { AttachMenu, LinkMenu } from './ChipMenus';
import { MachineAddPopover, MachineDrawer } from './MachineDrawer';
import { NewAiPopover } from './NewAiPopover';
import { RemoteMachineNode } from './RemoteMachineNode';
import { FORWARD_PULSE_MS, detectForwards, linkChip, linkWires } from './linkWires';
import { attachWires, machineKey, pruneMachinePositions, routeDrop, type DropRoute } from './machineLayout';
import { PaneDrawer, SLIDE_MS } from './PaneDrawer';
import {
  PANE_H,
  PANE_W,
  addPane,
  autoConnect,
  clearAgent,
  connectPane,
  disconnectPane,
  findFreeSpot,
  focusPane,
  loadPanes,
  movePane,
  paneBox,
  paneVisible,
  placeUnplaced,
  placementObstacles,
  prunePanes,
  removePane,
  resizePane,
  savePanes,
  startNextTo,
  type PaneNode,
  type PaneSource,
} from './paneStore';
import { isWireDrag, paneAtDrop, paneWires, routeClick, sourcePoint, wireMid } from './paneWires';
import { labelScale, lodFor, snapToPixel } from './lod';
import { findFreeSpotAvoiding, lastMonitorStart, leftMonitorInset, nudgeCentre, seamBandsWorld } from './seams';
import { MAX_ZOOM, MIN_ZOOM, fitView, screenToWorld, tweenView, viewForBox, zoomAt, type View } from './viewport';
import './canvas.css';
import './canvasPane.css';
import './canvasR3.css';

export interface CanvasProps {
  machine: string;
  sessions: SessionInfo[];
  runners?: Record<string, RunnerState>;
  selectedSessionId: string | null;
  selectedAgentId: string | null;
  onSelect: (sessionId: string, agentId: string | null) => void;
  onOpenFull: (sessionId: string) => void;
  char: CharView;
  onCharClick: () => void;
  /** Percent of the width, from the right edge, that floating widgets cover; "fit" centres the graph in the rest. */
  insetRightPct: number;
  /** Client-x of each monitor boundary when the window spans several monitors (?seams=); empty / absent: one monitor. */
  seams?: readonly number[];
  /** Widget show/hide toggles, drawn top-left over the canvas. */
  dock?: ReactNode;
  /** Sends commands to sessions (pane send box, rail controls). Missing = panes are read-only. */
  command?: Command;
  /** Relay links A -> B between sessions. */
  links?: LinkInfo[];
  /** Other machines (SSH), the sessions attached to them and the Tailscale peers offered when adding one. */
  machines?: MachineInfo[];
  attachments?: MachineAttachment[];
  peers?: TailscalePeer[];
  /** Folders a new job may start in (the "+ AI" popover). */
  cwds?: string[];
  /** Why commands cannot be sent right now (offline / demo), or null. */
  offlineReason?: string | null;
  /** "งานที่บันทึกไว้" widget state, for the toolbar button. */
  savedOpen?: boolean;
  onToggleSaved?: () => void;
  /** Ask the canvas to fly to a session's node (and open its drawer); waits up to 15 s for the node to appear. */
  reveal?: { sessionId: string; n: number; open: boolean } | null;
}

const DRAG_PX = 4;
const MODEL_DX = 64;
const AGENTS_DX = CARD_W - 64;
const validTitle = (t: string): boolean => !!t && t !== '(ไม่มีชื่อ)';

// ---- nodes (memoised on primitives, so dragging one node does not re-render the others) ----

interface SessionNodeProps {
  box: Box;
  sid: string;
  status: Status;
  selected: boolean;
  title: string;
  subtitle: string;
  thought: string;
  limit?: string | null;
  asks: number;
  rc: boolean;
  risk: boolean;
  /** At least one pane node is connected to this session. */
  wired: boolean;
  /** A wire being dragged is over this card (it would make a relay link). */
  hot: boolean;
  onPlus: (sid: string) => void;
}

const SessionNode = memo(function SessionNode(p: SessionNodeProps) {
  const word = STATUS_WORD[p.status];
  const label = `งาน ${p.title} ${word}${p.limit ? ` ${p.limit}` : ''}${p.asks > 0 ? ` มีคำถามรอ ${p.asks}` : ''}`;
  return (
    <div
      className={`cv-node${p.selected ? ' is-selected' : ''}${p.hot ? ' is-hot' : ''}`}
      data-node={p.sid}
      data-kind="session"
      data-sid={p.sid}
      data-status={p.status}
      data-limit={p.limit ? '1' : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={p.selected}
      aria-label={label}
      title={`${word}: ${p.title}`}
      style={{ left: p.box.x, top: p.box.y, width: CARD_W, height: CARD_H }}
    >
      <div className="cv-card">
        <span className="cv-dot" aria-hidden="true" />
        <span className="cv-icon">
          <AgentIcon />
        </span>
        <span className="cv-text">
          <span className="cv-title">{p.title}</span>
          <span className="cv-subtitle">{p.subtitle}</span>
        </span>
      </div>
      <span className="cv-in" aria-hidden="true" />
      <span className="cv-out" data-port-out="1" data-sid={p.sid} aria-hidden="true" />
      <span className={`cv-stub${p.wired ? ' is-wired' : ''}`} aria-hidden="true" />
      <button
        type="button"
        className={`cv-plus${p.wired ? ' is-wired' : ''}`}
        data-nodrag="1"
        aria-label={`เพิ่มช่องดูงานที่ต่อกับ ${p.title}`}
        title="เพิ่มช่องดูงานที่ต่อกับงานนี้ (หรือลากจุดขวาไปวางที่ช่อง)"
        onClick={() => p.onPlus(p.sid)}
      >
        +
      </button>
      {(p.asks > 0 || p.rc || p.risk) && (
        <span className="cv-badges" aria-hidden="true">
          {p.risk && <span className="cv-badge is-risk">bypass</span>}
          {p.rc && <span className="cv-badge">RC</span>}
          {p.asks > 0 && <span className="cv-badge is-ask">? {p.asks}</span>}
        </span>
      )}
      <span className="cv-diamond" style={{ left: MODEL_DX, top: CARD_H - 5.5 }} aria-hidden="true" />
      <span className="cv-portlabel" style={{ left: MODEL_DX, top: CARD_H + 6 }} aria-hidden="true">
        Model
      </span>
      <span className="cv-diamond" style={{ left: AGENTS_DX, top: CARD_H - 5.5 }} aria-hidden="true" />
      <span className="cv-portlabel" style={{ left: AGENTS_DX, top: CARD_H + 6 }} aria-hidden="true">
        Subagents
      </span>
      <div className="cv-caption" style={{ top: CARD_H + CAPTION_GAP, height: CAPTION_H }}>
        {p.limit ? <span className="cv-limit">{p.limit}</span> : p.thought || word}
      </div>
    </div>
  );
});

interface RoundProps {
  nodeKey: string;
  kind: 'model' | 'agent' | 'more';
  box: Box;
  sid: string;
  aid: string | null;
  status: Status | null;
  selected: boolean;
  inner: string;
  label: string;
  sub: string;
  aria: string;
}

const RoundNode = memo(function RoundNode(p: RoundProps) {
  return (
    <div
      className={`cv-node${p.selected ? ' is-selected' : ''}`}
      data-node={p.nodeKey}
      data-kind={p.kind}
      data-sid={p.sid}
      data-aid={p.aid ?? undefined}
      data-status={p.status ?? undefined}
      role="button"
      tabIndex={0}
      aria-label={p.aria}
      aria-pressed={p.kind === 'more' ? undefined : p.selected}
      title={p.aria}
      style={{ left: p.box.x, top: p.box.y, width: p.box.w, height: p.box.h }}
    >
      <div className="cv-circle">
        {p.kind === 'agent' ? (
          <span className="cv-circle-icon">
            <BranchIcon size={22} />
          </span>
        ) : p.kind === 'model' ? (
          <span>{p.inner}</span>
        ) : (
          <span>{p.inner}</span>
        )}
        {p.kind === 'agent' && <span className="cv-out-sub" data-port-out="1" data-sid={p.sid} data-aid={p.aid ?? undefined} aria-hidden="true" />}
      </div>
      <div className="cv-label">{p.label}</div>
      {p.sub && <div className="cv-sublabel">{p.sub}</div>}
    </div>
  );
});

interface MachineProps {
  box: Box;
  name: string;
  char: CharView;
  onCharClick: () => void;
}

const MachineNode = memo(function MachineNode({ box, name, char, onCharClick }: MachineProps) {
  const asking = char.state === 'asking';
  return (
    <div
      className="cv-node"
      data-node={MACHINE_KEY}
      data-kind="machine"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      role="group"
      aria-label={`เครื่อง ${name}`}
    >
      <div className="cv-machine-char">
        {asking ? (
          <button
            type="button"
            className="cg-char-btn"
            data-nodrag="1"
            onClick={onCharClick}
            aria-label={`${char.label} — กดเพื่อเปิดคำถาม`}
            title="กดเพื่อเปิดคำถามที่รออยู่"
          >
            <Character state={char.state} />
          </button>
        ) : (
          <Character state={char.state} />
        )}
      </div>
      <div className="cv-shape" style={{ left: SHAPE.dx, top: SHAPE.dy, width: SHAPE.w, height: SHAPE.h }}>
        <ComputerIcon size={34} />
        <span className="cv-out" aria-hidden="true" />
      </div>
      <div className="cv-machine-name" title={name}>
        {name}
      </div>
      <div className="cv-mood" role="status" style={{ color: asking ? 'var(--waiting)' : char.state === 'error' ? 'var(--error)' : 'var(--text)' }}>
        {char.label}
      </div>
    </div>
  );
});

// ---- the canvas ------------------------------------------------------------

type DragKind = 'pan' | 'node' | 'pane-move' | 'pane-resize' | 'wire';

interface Drag {
  pointerId: number;
  kind: DragKind;
  sx: number;
  sy: number;
  moved: boolean;
  startView: View;
  key: string;
  nodeKind: string;
  sid: string | null;
  aid: string | null;
  base: Point;
  /** pane-resize: size at the start. */
  size0: { w: number; h: number };
  /** wire: where it leaves the graph and which block it carries. */
  wireFrom: Point;
  wireSrc: PaneSource | null;
}

interface WireDrag {
  from: Point;
  to: Point;
  /** What a drop here would do (without knowing about the DOM): used only to highlight the target. */
  over: DropRoute;
}

/** Message shown next to the drop point when a link / attach is refused. */
interface Toast {
  x: number;
  y: number;
  text: string;
}

/** A chip menu: a relay link or an SSH attachment, anchored at the chip. */
type MenuState = { kind: 'link'; id: string } | { kind: 'attach'; sessionId: string; machineId: string };

const TOAST_MS = 6000;
const REVEAL_WAIT_MS = 15_000;

interface DrawerState {
  source: PaneSource;
  closing: boolean;
}

const zoomPct = (k: number): string => `${Math.round(k * 100)}%`;
const MOVING_IDLE_MS = 150;
const TWEEN_MS = 450;

const reducedMotion = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

const NO_LINKS: LinkInfo[] = [];
const NO_MACHINES: MachineInfo[] = [];
const NO_ATTACH: MachineAttachment[] = [];
const NO_PEERS: TailscalePeer[] = [];
const NO_CWDS: string[] = [];
const NO_SEAMS: readonly number[] = [];

export function Canvas({
  machine,
  sessions,
  runners,
  selectedSessionId,
  selectedAgentId,
  onSelect,
  onOpenFull,
  char,
  onCharClick,
  insetRightPct,
  seams = NO_SEAMS,
  dock,
  command,
  links = NO_LINKS,
  machines = NO_MACHINES,
  attachments = NO_ATTACH,
  peers = NO_PEERS,
  cwds = NO_CWDS,
  offlineReason = null,
  savedOpen = false,
  onToggleSaved,
  reveal = null,
}: CanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ x: 48, y: 48, k: 1 });
  const multi = seams.length > 0;
  // Several monitors: the graph is fitted into the left-most one; widgets and work panes live on the others.
  const insetRight = multi ? leftMonitorInset(seams, size.w) : Math.round((size.w * insetRightPct) / 100);
  const seamsRef = useRef(seams);
  seamsRef.current = seams;
  const viewRef = useRef(view);
  viewRef.current = view;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const insetRef = useRef(insetRight);
  insetRef.current = insetRight;
  const auto = useRef(true); // keep fitting until the user pans, zooms or drags a node
  const [positions, setPositions] = useState<StoredPositions>(() => loadPositions());
  const posRef = useRef(positions);
  posRef.current = positions;
  // Positions the automatic placement works from: they change when a drag ends or the node set changes, so other
  // nodes do not hop around while a node is being dragged.
  const [settled, setSettled] = useState<StoredPositions>(positions);
  const [panes, setPanes] = useState<PaneNode[]>(() => loadPanes());
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const [selWire, setSelWire] = useState<string | null>(null);
  const [wireDrag, setWireDrag] = useState<WireDrag | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const drawerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [popover, setPopover] = useState<'ai' | 'machine' | null>(null);
  const [mDrawer, setMDrawer] = useState<string | null>(null); // id of the machine shown in its drawer
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pulse, setPulse] = useState<ReadonlySet<string>>(() => new Set());
  const pulseTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seenForwards = useRef<Record<string, number | null> | null>(null);
  const pendingReveal = useRef<{ sessionId: string; open: boolean; until: number } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [panning, setPanning] = useState(false);
  const [moving, setMoving] = useState(false);
  const movingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tween = useRef(0);
  const drag = useRef<Drag | null>(null);
  const lastTap = useRef<{ key: string; t: number } | null>(null);

  // will-change only while a pan / zoom gesture runs, so Chrome re-rasterises the text at the final scale.
  // When the gesture ends the view snaps to whole device pixels.
  const touchMoving = useCallback(() => {
    setMoving(true);
    if (movingTimer.current) clearTimeout(movingTimer.current);
    movingTimer.current = setTimeout(() => {
      movingTimer.current = null;
      setMoving(false);
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      setView((v) => {
        const x = snapToPixel(v.x, dpr);
        const y = snapToPixel(v.y, dpr);
        return x === v.x && y === v.y ? v : { ...v, x, y };
      });
    }, MOVING_IDLE_MS);
  }, []);
  useEffect(
    () => () => {
      if (movingTimer.current) clearTimeout(movingTimer.current);
      if (drawerTimer.current) clearTimeout(drawerTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      for (const t of pulseTimers.current.values()) clearTimeout(t);
      cancelAnimationFrame(tween.current);
    },
    [],
  );

  const showToast = useCallback((text: string, at: { x: number; y: number }) => {
    const r = rootRef.current?.getBoundingClientRect();
    setToast({ x: at.x - (r?.left ?? 0), y: at.y - (r?.top ?? 0), text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The "finished within 10 minutes" rule is re-checked even when no data arrives.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);

  // Automatic layout depends only on the data, not on drags.
  const auto0 = useMemo(() => layoutCanvas(sessions, { now, expanded }), [sessions, now, expanded]);
  // Collision-aware placement on the settled positions; the live drag is laid over it.
  // Every node that has been placed is remembered (see the persist effect below), so only NEW nodes are placed here
  // and a node never moves because the order, the activity or the size of other nodes changed. Panes are obstacles
  // for new nodes only (read from a ref: moving a pane must not re-place anything).
  const resolved = useMemo(
    () => resolvePlacement(auto0, settled, { separateStored: false, obstacles: panesRef.current.filter((p) => !p.unplaced).map(paneBox) }),
    [auto0, settled],
  );
  const settledMachines = useMemo(() => placeMachines(machines, resolved.machine, resolved, settled), [machines, resolved, settled]);
  const settledAll = useMemo(() => withMachines(resolved, settledMachines), [resolved, settledMachines]);
  const placed = useMemo(() => applyPositions(resolved, liveOverride(positions, settled)), [resolved, positions, settled]);
  const machinePlaces = useMemo(
    () => settledMachines.map((m) => (positions[machineKey(m.id)] ? { ...m, box: { ...m.box, x: positions[machineKey(m.id)].x, y: positions[machineKey(m.id)].y } } : m)),
    [settledMachines, positions],
  );
  const placedAll = useMemo(() => withMachines(placed, machinePlaces), [placed, machinePlaces]);

  // Remember the spot of every newly placed node (session, local machine node, remote machine) so it stays put.
  useEffect(() => {
    const next = persistAutoPlacement(posRef.current, resolved, settledMachines);
    if (next === posRef.current) return;
    posRef.current = next;
    setPositions(next);
    setSettled(next);
    savePositions(next);
  }, [resolved, settledMachines]);
  const placedRef = useRef(placedAll);
  placedRef.current = placedAll;
  const machinePlacesRef = useRef(machinePlaces);
  machinePlacesRef.current = machinePlaces;
  // A session on another machine hangs from that machine's node instead of the local one.
  const remoteOrigins = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    for (const s of sessions) {
      const mp = s.machineId ? machinePlaces.find((m) => m.id === s.machineId) : undefined;
      if (mp) out.set(s.sessionId, { x: mp.box.x + mp.box.w, y: mp.box.y + mp.box.h / 2 });
    }
    return out;
  }, [sessions, machinePlaces]);
  const edges = useMemo(() => canvasEdges(placed, remoteOrigins), [placed, remoteOrigins]);
  const wires = useMemo(() => paneWires(placed, panes), [placed, panes]);
  const lWires = useMemo(() => linkWires(placed, links), [placed, links]);
  const aWires = useMemo(() => attachWires(placed, machinePlaces, attachments), [placed, machinePlaces, attachments]);
  const machineById = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines]);
  const wiredSessions = useMemo(() => new Set(panes.filter((p) => p.source).map((p) => p.source!.sessionId)), [panes]);
  const topPaneId = useMemo(() => panes.reduce<PaneNode | null>((a, p) => (!a || p.z >= a.z ? p : a), null)?.id ?? null, [panes]);

  // Forget positions of sessions that are gone (only once there is a live list to compare with).
  const idsKey = sessions.map((s) => s.sessionId).join('|');
  useEffect(() => {
    if (sessions.length === 0) return;
    const next = prunePositions(posRef.current, new Set(sessions.map((s) => s.sessionId)));
    if (next !== posRef.current) {
      setPositions(next);
      setSettled(next);
      savePositions(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // Forget positions of machines that were deleted (only while there is a machine list to compare with).
  const machineIdsKey = machines.map((m) => m.id).join('|');
  useEffect(() => {
    if (machines.length === 0) return;
    const next = pruneMachinePositions(posRef.current, new Set(machines.map((m) => m.id)));
    if (next !== posRef.current) {
      setPositions(next);
      setSettled(next);
      savePositions(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineIdsKey]);

  // A relay forward happened: its link flows for 1.5 s.
  useEffect(() => {
    const r = detectForwards(seenForwards.current, links);
    seenForwards.current = r.next;
    if (r.fired.length === 0) return;
    setPulse((cur) => new Set([...cur, ...r.fired]));
    for (const id of r.fired) {
      const old = pulseTimers.current.get(id);
      if (old) clearTimeout(old);
      pulseTimers.current.set(
        id,
        setTimeout(() => {
          pulseTimers.current.delete(id);
          setPulse((cur) => {
            const next = new Set(cur);
            next.delete(id);
            return next;
          });
        }, FORWARD_PULSE_MS),
      );
    }
  }, [links]);

  // Esc closes an open chip menu or popover (focus may still be on the chip that opened it).
  const overlayOpen = menu !== null || popover !== null;
  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(null);
      setPopover(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlayOpen]);

  // A menu whose link / attachment is gone closes by itself; so does a drawer of a deleted machine.
  useEffect(() => {
    if (menu?.kind === 'link' && !links.some((l) => l.id === menu.id)) setMenu(null);
    if (menu?.kind === 'attach' && !attachments.some((a) => a.sessionId === menu.sessionId && a.machineId === menu.machineId)) setMenu(null);
  }, [menu, links, attachments]);
  useEffect(() => {
    if (mDrawer && machines.length > 0 && !machineById.has(mDrawer)) setMDrawer(null);
  }, [mDrawer, machines.length, machineById]);

  // Pane connections: migrated panes take a running session, connections to vanished sessions are cut.
  useEffect(() => {
    if (sessions.length === 0) return;
    setPanes((cur) => prunePanes(autoConnect(cur, sessions), new Set(sessions.map((s) => s.sessionId))));
  }, [sessions]);

  // Migrated panes get a spot right of the graph once the graph exists.
  useEffect(() => {
    if (!placed.empty) setPanes((cur) => placeUnplaced(cur, placed));
  }, [placed]);

  // A pane that ended up on a node (the node set changed, a card was dropped on it) moves to the first free spot.
  // Runs on the settled layout only, so dragging a pane or a card never makes anything jump mid-drag.
  // Only when the stored positions or the node set change, never because a block grew.
  const settledAllRef = useRef(settledAll);
  settledAllRef.current = settledAll;
  useEffect(() => {
    if (settledAllRef.current.empty) return;
    setPanes((cur) => resolvePanes(cur, settledAllRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, idsKey, machineIdsKey]);

  // Persist pane nodes (debounced; drags change them on every move).
  useEffect(() => {
    const t = setTimeout(() => savePanes(panes), 250);
    return () => clearTimeout(t);
  }, [panes]);

  const fitBounds = useMemo(() => fitBoundsOf(placedAll, multi ? [] : panes), [placedAll, panes, multi]);
  const fit = useCallback(() => {
    setView(fitView(fitBounds, size, { insetRight, padTop: 40, padBottom: 40 }));
  }, [fitBounds, size, insetRight]);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // Fit once when the graph first appears and when the window is resized; never because nodes changed or a widget
  // opened, so sending a message or clicking a button never moves the view.
  const fittedRef = useRef(false);
  const lastSizeRef = useRef('');
  const hasGraph = !placed.empty;
  useEffect(() => {
    if (!auto.current || size.w <= 0 || size.h <= 0) return;
    const sk = `${size.w}x${size.h}`;
    const resized = lastSizeRef.current !== sk;
    lastSizeRef.current = sk;
    if (!hasGraph) return;
    if (!fittedRef.current || resized) {
      fittedRef.current = true;
      fitRef.current();
    }
  }, [hasGraph, size.w, size.h]);

  // Wheel: zoom around the cursor. Over a pane or the drawer the wheel scrolls the log instead (Ctrl+wheel still zooms).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element | null;
      if (!e.ctrlKey && target?.closest?.('[data-pane],[data-drawer]')) return;
      e.preventDefault();
      cancelAnimationFrame(tween.current);
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      auto.current = false;
      touchMoving();
      setView((v) => zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [touchMoving]);

  const zoomBy = (factor: number) => {
    auto.current = false;
    touchMoving();
    setView((v) => zoomAt(v, factor, (size.w - insetRight) / 2, size.h / 2));
  };

  const animateTo = useCallback(
    (target: View) => {
      cancelAnimationFrame(tween.current);
      auto.current = false;
      if (reducedMotion()) {
        setView(target);
        return;
      }
      const from = viewRef.current;
      const t0 = performance.now();
      const step = (t: number) => {
        const f = (t - t0) / TWEEN_MS;
        touchMoving();
        setView(tweenView(from, target, f));
        if (f < 1) tween.current = requestAnimationFrame(step);
      };
      tween.current = requestAnimationFrame(step);
    },
    [touchMoving],
  );

  const toggleExpanded = useCallback((sid: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  }, []);

  // ---- pane nodes ----
  const commitPanes = useCallback((next: PaneNode[]) => {
    panesRef.current = next;
    setPanes(next);
  }, []);

  const viewCentre = (): Point => {
    const s = sizeRef.current;
    const c = screenToWorld(viewRef.current, { x: (s.w - insetRef.current) / 2, y: s.h / 2 });
    return { x: c.x - PANE_W / 2, y: c.y - PANE_H / 2 };
  };

  /** Where a new work pane starts: the view centre, or the top of the last monitor when the window spans several. */
  const paneStart = (): Point => (seamsRef.current.length > 0 ? lastMonitorStart(seamsRef.current, viewRef.current) : viewCentre());
  /** Seam bands in world coords at the current zoom: new panes keep off them. */
  const seamBands = (): Box[] => (seamsRef.current.length > 0 ? seamBandsWorld(seamsRef.current, viewRef.current) : []);

  const addPaneFor = useCallback(
    (source: PaneSource | null, start: Point): string => {
      const spot = findFreeSpotAvoiding({ w: PANE_W, h: PANE_H }, start, placementObstacles(placedRef.current, panesRef.current), seamBands());
      const r = addPane(panesRef.current, { x: spot.x, y: spot.y, source });
      commitPanes(r.panes);
      return r.id;
    },
    [commitPanes],
  );

  const goToPane = useCallback(
    (id: string) => {
      const p = panesRef.current.find((q) => q.id === id);
      if (!p) return;
      commitPanes(focusPane(panesRef.current, id));
      const sm = seamsRef.current;
      if (sm.length > 0) {
        // several monitors: bring the pane to the middle of the last monitor
        const s = sizeRef.current;
        const x0 = sm[sm.length - 1];
        const v = viewForBox(paneBox(p), { w: Math.max(1, s.w - x0), h: s.h }, { maxZoom: 1 });
        animateTo({ ...v, x: v.x + x0 });
      } else animateTo(viewForBox(paneBox(p), sizeRef.current, { insetRight: insetRef.current, maxZoom: 1 }));
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-pane="${id}"]`)?.focus({ preventScroll: true }));
    },
    [animateTo, commitPanes],
  );

  const addEmptyPane = () => {
    addPaneFor(null, paneStart());
  };

  const addConnectedPane = useCallback(
    (source: PaneSource, at?: Point): string => {
      if (at) {
        const free = findFreeSpotAvoiding({ w: PANE_W, h: PANE_H }, at, placementObstacles(placedRef.current, panesRef.current), seamBands());
        const r = addPane(panesRef.current, { x: free.x, y: free.y, source });
        commitPanes(r.panes);
        return r.id;
      }
      return addPaneFor(source, seamsRef.current.length > 0 ? paneStart() : (startNextTo(placedRef.current, source.sessionId) ?? viewCentre()));
    },
    [addPaneFor, commitPanes],
  );

  // "จัดเรียงใหม่": forget every dragged position and lay everything out again without overlaps.
  const relayout = (e: { clientX: number; clientY: number }) => {
    const empty: StoredPositions = {};
    const lay = resolvePlacement(auto0, empty);
    const full = withMachines(lay, placeMachines(machines, lay.machine, lay, empty));
    posRef.current = empty;
    setPositions(empty);
    setSettled(empty);
    savePositions(empty);
    const s = sizeRef.current;
    const sm = seamsRef.current;
    // several monitors: the graph fills the left monitor; work panes are laid out on the last one at that zoom
    const nextView = s.w > 0 && s.h > 0 ? fitView(fitBoundsOf(full, sm.length > 0 ? [] : panesRef.current), s, { insetRight: insetRef.current, padTop: 40, padBottom: 40 }) : null;
    const panesNext = relayoutPanes(panesRef.current, full, sm.length > 0 && nextView ? { start: lastMonitorStart(sm, nextView), bands: seamBandsWorld(sm, nextView) } : undefined);
    commitPanes(panesNext);
    auto.current = true;
    if (nextView && sm.length === 0) setView(fitView(fitBoundsOf(full, panesNext), s, { insetRight: insetRef.current, padTop: 40, padBottom: 40 }));
    else if (nextView) setView(nextView);
    showToast('จัดเรียงใหม่แล้ว', { x: e.clientX, y: e.clientY + 36 });
  };

  const onPlus = useCallback((sid: string) => void addConnectedPane({ sessionId: sid, agentId: null }), [addConnectedPane]);

  const paneClose = useCallback(
    (id: string) => {
      commitPanes(removePane(panesRef.current, id));
      setSelWire((w) => (w === id ? null : w));
    },
    [commitPanes],
  );
  const paneConnect = useCallback((id: string, sid: string) => commitPanes(connectPane(panesRef.current, id, { sessionId: sid, agentId: null })), [commitPanes]);
  const paneDisconnect = useCallback((id: string) => commitPanes(disconnectPane(panesRef.current, id)), [commitPanes]);
  const paneClearAgent = useCallback((id: string) => commitPanes(clearAgent(panesRef.current, id)), [commitPanes]);
  const paneNudge = useCallback(
    (id: string, dx: number, dy: number, resize: boolean) => {
      const p = panesRef.current.find((q) => q.id === id);
      if (!p) return;
      auto.current = false;
      commitPanes(resize ? resizePane(panesRef.current, id, p.w + dx, p.h + dy) : movePane(panesRef.current, id, p.x + dx, p.y + dy));
    },
    [commitPanes],
  );

  // ---- slide-out drawer ----
  const closeDrawer = useCallback(() => {
    setDrawer((d) => (d && !d.closing ? { ...d, closing: true } : d));
    if (drawerTimer.current) clearTimeout(drawerTimer.current);
    drawerTimer.current = setTimeout(
      () => {
        drawerTimer.current = null;
        setDrawer((d) => (d && d.closing ? null : d));
      },
      reducedMotion() ? 0 : SLIDE_MS,
    );
  }, []);
  const openDrawer = useCallback((source: PaneSource) => {
    if (drawerTimer.current) {
      clearTimeout(drawerTimer.current);
      drawerTimer.current = null;
    }
    setMDrawer(null);
    setDrawer({ source, closing: false });
  }, []);

  // A machine node opens its own drawer (one drawer at a time).
  const openMachine = useCallback((id: string) => {
    if (drawerTimer.current) {
      clearTimeout(drawerTimer.current);
      drawerTimer.current = null;
    }
    setDrawer(null);
    setPopover(null);
    setMenu(null);
    setMDrawer(id);
  }, []);

  // Click on an AI block: a pane already connected to it comes into view, otherwise the block slides out in the drawer.
  const clickBlock = useCallback(
    (sid: string, aid: string | null) => {
      onSelect(sid, aid);
      const route = routeClick(panesRef.current, sid, aid);
      if (route.kind === 'focus') {
        closeDrawer();
        goToPane(route.paneId);
      } else openDrawer({ sessionId: sid, agentId: aid });
    },
    [closeDrawer, goToPane, onSelect, openDrawer],
  );

  // Fly to a session's node (and open its drawer): "ไปที่บล็อก", a resumed job, a job just started with "+ AI".
  const [revealTick, setRevealTick] = useState(0);
  const flyToSession = useCallback(
    (sid: string): boolean => {
      const s = placedRef.current.sessions.find((x) => x.sessionId === sid);
      if (!s) return false;
      animateTo(viewForBox(s.card, sizeRef.current, { insetRight: insetRef.current, maxZoom: 1 }));
      return true;
    },
    [animateTo],
  );
  const requestReveal = useCallback((sessionId: string, open: boolean) => {
    pendingReveal.current = { sessionId, open, until: Date.now() + REVEAL_WAIT_MS };
    setRevealTick((n) => n + 1);
  }, []);
  const revealN = reveal?.n ?? 0;
  useEffect(() => {
    if (reveal) requestReveal(reveal.sessionId, reveal.open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealN]);

  const activate = useCallback(
    (kind: string, sid: string | null, aid: string | null) => {
      if (!sid) return;
      if (kind === 'more') toggleExpanded(sid);
      else if (kind === 'agent' && aid) clickBlock(sid, aid);
      else if (kind === 'session' || kind === 'model') clickBlock(sid, null);
    },
    [clickBlock, toggleExpanded],
  );

  useEffect(() => {
    const p = pendingReveal.current;
    if (!p) return;
    if (Date.now() > p.until) {
      pendingReveal.current = null;
      return;
    }
    if (!placedRef.current.sessions.some((x) => x.sessionId === p.sessionId)) return; // not here yet: runs again when the list changes
    pendingReveal.current = null;
    flyToSession(p.sessionId);
    if (p.open) clickBlock(p.sessionId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, revealTick]);

  const pinDrawer = () => {
    if (!drawer) return;
    const id = addConnectedPane(drawer.source);
    closeDrawer();
    goToPane(id);
  };

  // Delete / Backspace removes the selected wire; Esc deselects it.
  useEffect(() => {
    if (!selWire) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        commitPanes(disconnectPane(panesRef.current, selWire));
        setSelWire(null);
      } else if (e.key === 'Escape') setSelWire(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selWire, commitPanes]);

  // ---- pointer: pan on empty canvas, drag a node / pane / wire, click = open ----
  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current?.getBoundingClientRect();
    return screenToWorld(viewRef.current, { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) });
  };

  const dropCtx = () => ({
    panes: panesRef.current,
    cards: placedRef.current.sessions.map((x) => ({ sessionId: x.sessionId, card: x.card })),
    machines: machinePlacesRef.current,
  });

  const sendWire = async (cmd: Parameters<NonNullable<typeof command>>[0], at: { x: number; y: number }) => {
    if (!command) {
      showToast(offlineReason ?? 'ยังสั่งงานไม่ได้', at);
      return;
    }
    const r = await command(cmd);
    if (!r.ok) showToast(r.error ?? 'เชื่อมไม่สำเร็จ ลองอีกครั้ง', at);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const t = e.target as HTMLElement;
    cancelAnimationFrame(tween.current);
    const blank: Drag = {
      pointerId: e.pointerId,
      kind: 'pan',
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      startView: viewRef.current,
      key: '',
      nodeKind: '',
      sid: null,
      aid: null,
      base: { x: 0, y: 0 },
      size0: { w: 0, h: 0 },
      wireFrom: { x: 0, y: 0 },
      wireSrc: null,
    };
    const capture = () => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
    };

    // A pane: focus it; its title bar moves it, its corner resizes it; the rest (log, rail, send box) is the pane's own.
    const paneEl = t.closest<HTMLElement>('[data-pane]');
    if (paneEl) {
      const id = paneEl.dataset.pane as string;
      const next = focusPane(panesRef.current, id);
      if (next !== panesRef.current) commitPanes(next);
      const pane = panesRef.current.find((p) => p.id === id);
      if (!pane) return;
      const resize = !!t.closest('[data-resize]');
      const handle = !!t.closest('[data-panehandle]') && !t.closest('[data-nodrag]');
      if (!resize && !handle) return;
      drag.current = { ...blank, kind: resize ? 'pane-resize' : 'pane-move', key: id, base: { x: pane.x, y: pane.y }, size0: { w: pane.w, h: pane.h } };
      capture();
      return;
    }

    if (t.closest('[data-chrome]') || t.closest('[data-nodrag]')) return;

    // An output port (session card or subagent circle): dragging from it pulls out a wire.
    const portEl = t.closest<HTMLElement>('[data-port-out]');
    if (portEl?.dataset.sid) {
      const src: PaneSource = { sessionId: portEl.dataset.sid, agentId: portEl.dataset.aid ?? null };
      drag.current = { ...blank, kind: 'wire', wireSrc: src, wireFrom: sourcePoint(placedRef.current, src) ?? toWorld(e) };
      capture();
      return;
    }

    const nodeEl = t.closest<HTMLElement>('[data-node]');
    const key = nodeEl?.dataset.node ?? '';
    let base: Point = { x: 0, y: 0 };
    if (nodeEl) {
      if (key === MACHINE_KEY) base = { x: placed.machine.x, y: placed.machine.y };
      else if (nodeEl.dataset.kind === 'rmachine') {
        const m = machinePlacesRef.current.find((x) => x.id === nodeEl.dataset.mid);
        base = m ? { x: m.box.x, y: m.box.y } : base;
      }
      else if (nodeEl.dataset.kind === 'session') {
        const s = placed.sessions.find((x) => x.sessionId === key);
        base = s ? { x: s.card.x, y: s.card.y } : base;
      } else base = positions[key] ?? { x: 0, y: 0 };
    }
    drag.current = {
      ...blank,
      kind: nodeEl ? 'node' : 'pan',
      key,
      nodeKind: nodeEl?.dataset.kind ?? '',
      sid: nodeEl?.dataset.sid ?? null,
      aid: nodeEl?.dataset.aid ?? null,
      base,
    };
    capture();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && !isWireDrag(dx, dy, DRAG_PX)) return;
    if (!d.moved) {
      d.moved = true;
      auto.current = false;
      if (d.kind === 'pan') setPanning(true);
    }
    const k = d.startView.k;
    if (d.kind === 'pan') {
      touchMoving();
      setView({ ...d.startView, x: d.startView.x + dx, y: d.startView.y + dy });
    } else if (d.kind === 'node') {
      const next = { x: d.base.x + dx / k, y: d.base.y + dy / k };
      setPositions((p) => ({ ...p, [d.key]: next }));
    } else if (d.kind === 'pane-move') {
      commitPanes(movePane(panesRef.current, d.key, d.base.x + dx / k, d.base.y + dy / k));
    } else if (d.kind === 'pane-resize') {
      commitPanes(resizePane(panesRef.current, d.key, d.size0.w + dx / k, d.size0.h + dy / k));
    } else if (d.kind === 'wire') {
      const to = toWorld(e);
      setWireDrag({ from: d.wireFrom, to, over: d.wireSrc ? routeDrop(dropCtx(), d.wireSrc, to, false) : { kind: 'none' } });
    }
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (d.kind === 'node') {
      if (d.moved) {
        savePositions(posRef.current);
        setSettled(posRef.current);
      }
      else if (!cancelled) {
        // Pointer capture makes dblclick events target the canvas, so a second tap on the same node is detected here.
        const t = performance.now();
        const prev = lastTap.current;
        if (prev && prev.key === d.key && t - prev.t < 350 && d.nodeKind !== 'more' && d.nodeKind !== 'rmachine' && d.sid) {
          lastTap.current = null;
          onOpenFull(d.sid);
        } else if (d.nodeKind === 'rmachine') {
          lastTap.current = null;
          openMachine(d.key.slice(3));
        } else {
          lastTap.current = { key: d.key, t };
          activate(d.nodeKind, d.sid, d.aid);
        }
      }
    } else if (d.kind === 'pane-move' || d.kind === 'pane-resize') {
      if (d.moved) savePanes(panesRef.current);
    } else if (d.kind === 'wire') {
      setWireDrag(null);
      if (d.moved && !cancelled && d.wireSrc) {
        const world = toWorld(e);
        const under = document.elementFromPoint(e.clientX, e.clientY);
        // Session cards and remote machines are known targets; any other node or the toolbar swallows the drop.
        const nodeUnder = under?.closest<HTMLElement>('[data-node]');
        const overNode = !!under?.closest('[data-chrome]') || (!!nodeUnder && nodeUnder.dataset.kind !== 'session' && nodeUnder.dataset.kind !== 'rmachine');
        const tgt = routeDrop(dropCtx(), d.wireSrc, world, overNode);
        const at = { x: e.clientX, y: e.clientY };
        if (tgt.kind === 'pane') {
          commitPanes(focusPane(connectPane(panesRef.current, tgt.id, d.wireSrc), tgt.id));
        } else if (tgt.kind === 'empty') {
          addConnectedPane(d.wireSrc, paneAtDrop(tgt.at, PANE_H));
        } else if (tgt.kind === 'link') {
          void sendWire({ type: 'link_create', from: d.wireSrc.sessionId, to: tgt.toSessionId }, at);
        } else if (tgt.kind === 'attach') {
          void sendWire({ type: 'machine_attach', sessionId: d.wireSrc.sessionId, machineId: tgt.machineId }, at);
        }
      }
    } else if (d.kind === 'pan' && !d.moved && !cancelled) {
      // a click on empty canvas
      setSelWire(null);
      setMenu(null);
      setToast(null);
      closeDrawer();
      setMDrawer(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-node]');
    if (!el || el.dataset.kind === 'machine' || e.target !== el) return;
    e.preventDefault();
    if (el.dataset.kind === 'rmachine') {
      if (el.dataset.mid) openMachine(el.dataset.mid);
      return;
    }
    if (e.shiftKey && el.dataset.sid && el.dataset.kind !== 'more') onOpenFull(el.dataset.sid);
    else activate(el.dataset.kind ?? '', el.dataset.sid ?? null, el.dataset.aid ?? null);
  };

  const nameOf = (sid: string): string => {
    const s = byId.get(sid);
    return s ? (validTitle(s.title) ? s.title : s.name) : sid.slice(0, 8);
  };
  const toScreen = (p: Point): Point => ({ x: view.x + p.x * view.k, y: view.y + p.y * view.k });
  const menuLink = menu?.kind === 'link' ? lWires.find((w) => w.id === menu.id) : undefined;
  const menuAttach = menu?.kind === 'attach' ? aWires.find((w) => w.sessionId === menu.sessionId && w.machineId === menu.machineId) : undefined;
  const openMachineInfo = mDrawer ? (machineById.get(mDrawer) ?? null) : null;

  const gridSize = Math.max(8, 24 * view.k);
  const lod = lodFor(view.k);
  const compact = lod === 'compact';
  const drawerSession = drawer ? (byId.get(drawer.source.sessionId) ?? null) : null;
  const selectedWire = selWire ? wires.find((w) => w.paneId === selWire) : undefined;
  const selectedMid = selectedWire ? wireMid(selectedWire.from, selectedWire.to) : null;
  const worldStyle = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
    ['--cs' as string]: labelScale(view.k),
  };

  return (
    <div
      ref={rootRef}
      className={`cv-root lod-${lod}${panning ? ' is-panning' : ''}${moving ? ' is-moving' : ''}${wireDrag ? ' is-wiring' : ''}`}
      role="region"
      aria-label="โครงข่ายงาน"
      style={{ backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, false)}
      onPointerCancel={(e) => endDrag(e, true)}
      onKeyDown={onKeyDown}
    >
      <div className="cv-world" style={worldStyle}>
        <svg className="cv-edges" aria-hidden="true" focusable="false">
          <defs>
            {(['ok', 'limit', 'bad', 'paused'] as const).map((t) => (
              <marker key={t} id={`cv-arrow-${t}`} className={`cv-arrow is-${t}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="4" markerHeight="4" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            ))}
          </defs>
          {edges.map((e) => {
            const st = byId.get(e.sessionId)?.status;
            const cls = e.kind === 'machine' ? (st === 'running' ? ' is-run' : st === 'waiting' ? ' is-wait' : '') : ' is-dashed';
            return <path key={e.key} d={e.d} className={`cv-edge${cls}`} />;
          })}
          {wires.map((w) => {
            const s = byId.get(w.sessionId);
            const st = w.agentId ? s?.subagents.find((a) => a.id === w.agentId)?.status : s?.status;
            const cls = st === 'running' ? ' is-run' : st === 'waiting' ? ' is-wait' : '';
            return (
              <g key={`w:${w.paneId}`}>
                <path d={w.d} className={`cv-edge cv-wire${cls}${selWire === w.paneId ? ' is-sel' : ''}`} />
                <path d={w.d} className="cv-wire-hit" data-nodrag="1" data-wire={w.paneId} onClick={() => setSelWire(w.paneId)} />
              </g>
            );
          })}
          {aWires.map((w) => (
            <g key={`at:${w.key}`}>
              <path d={w.d} className="cv-attach" />
            </g>
          ))}
          {lWires.map((w) => {
            const chip = linkChip(w.link);
            return (
              <g key={`ln:${w.id}`}>
                <path d={w.d} className={`cv-link-wire is-${chip.tone}${pulse.has(w.id) ? ' is-pulse' : ''}`} markerEnd={`url(#cv-arrow-${chip.tone})`} />
              </g>
            );
          })}
        </svg>

        <MachineNode box={placed.machine} name={machine} char={char} onCharClick={onCharClick} />

        {machinePlaces.map((pl) => {
          const m = machineById.get(pl.id);
          if (!m) return null;
          return <RemoteMachineNode key={pl.id} place={pl} machine={m} selected={mDrawer === pl.id} hot={wireDrag?.over.kind === 'attach' && wireDrag.over.machineId === pl.id} />;
        })}

        {placed.sessions.map((p) => {
          const s = byId.get(p.sessionId);
          if (!s) return null;
          const rn = runners?.[s.sessionId];
          const badges = modeBadges(rn);
          const mode = badges.filter((b) => b !== 'RC');
          const asks = (rn?.pending.length ?? 0) + (s.waitItems?.length ?? 0);
          const title = validTitle(s.title) ? s.title : s.name;
          const where = s.machineId ? [`@${machineById.get(s.machineId)?.name ?? s.machineId}`] : [];
          const subtitle = [...where, badgeText(s.model, s.effort), ...mode].join(' · ');
          return (
            <SessionNode
              key={s.sessionId}
              box={p.card}
              sid={s.sessionId}
              status={s.status}
              selected={s.sessionId === selectedSessionId && selectedAgentId === null}
              title={title}
              subtitle={subtitle}
              thought={s.thought}
              limit={limitText(s, rn)}
              asks={asks}
              rc={badges.includes('RC')}
              risk={mode.includes('bypassPermissions')}
              wired={wiredSessions.has(s.sessionId)}
              hot={wireDrag?.over.kind === 'link' && wireDrag.over.toSessionId === s.sessionId}
              onPlus={onPlus}
            />
          );
        })}

        {placed.sessions.flatMap((p) => {
          const s = byId.get(p.sessionId);
          if (!s) return [];
          return p.subs.map((b) => {
            if (b.kind === 'model') {
              const m = shortModel(s.model);
              return (
                <RoundNode
                  key={b.key}
                  nodeKey={b.key}
                  kind="model"
                  box={b.box}
                  sid={s.sessionId}
                  aid={null}
                  status={null}
                  selected={false}
                  inner={modelWord(s.model)}
                  label={m ?? 'ไม่ทราบโมเดล'}
                  sub={s.effort ?? ''}
                  aria={`โมเดล ${m ?? 'ไม่ทราบ'}${s.effort ? ` effort ${s.effort}` : ''}`}
                />
              );
            }
            if (b.kind === 'more') {
              return (
                <RoundNode
                  key={b.key}
                  nodeKey={b.key}
                  kind="more"
                  box={b.box}
                  sid={s.sessionId}
                  aid={null}
                  status={null}
                  selected={false}
                  inner={b.expanded ? '−' : `+${b.count}`}
                  label={b.expanded ? 'ซ่อนตัวที่เก่า' : `อีก ${b.count} ตัว`}
                  sub=""
                  aria={b.expanded ? 'ซ่อนงานย่อยที่เก่า' : `ดูงานย่อยที่เหลืออีก ${b.count} ตัว`}
                />
              );
            }
            const a = s.subagents.find((x) => x.id === b.agentId);
            if (!a) return null;
            return (
              <RoundNode
                key={b.key}
                nodeKey={b.key}
                kind="agent"
                box={b.box}
                sid={s.sessionId}
                aid={a.id}
                status={a.status}
                selected={s.sessionId === selectedSessionId && a.id === selectedAgentId}
                inner=""
                label={a.description}
                sub={shortModel(a.model) ?? ''}
                aria={`งานย่อย ${a.description} ${STATUS_WORD[a.status]}${a.thought ? ` — ${a.thought}` : ''}`}
              />
            );
          });
        })}

        {panes.map((pn) =>
          pn.unplaced ? null : (
            <CanvasPane
              key={pn.id}
              pane={pn}
              session={pn.source ? (byId.get(pn.source.sessionId) ?? null) : null}
              sessions={sessions}
              runner={pn.source ? runners?.[pn.source.sessionId] : undefined}
              command={command}
              compact={compact}
              visible={paneVisible(paneBox(pn), view, size)}
              hot={wireDrag?.over.kind === 'pane' && wireDrag.over.id === pn.id}
              focused={topPaneId === pn.id}
              onClose={paneClose}
              onConnect={paneConnect}
              onDisconnect={paneDisconnect}
              onClearAgent={paneClearAgent}
              onFullScreen={onOpenFull}
              onNudge={paneNudge}
            />
          ),
        )}

        {!compact && (
          <div className="cv-chips">
            {lWires.map((w) => {
              const chip = linkChip(w.link);
              return (
                <button
                  key={`lc:${w.id}`}
                  type="button"
                  className={`cv-chip is-${chip.tone}${pulse.has(w.id) ? ' is-pulse' : ''}${menu?.kind === 'link' && menu.id === w.id ? ' is-open' : ''}`}
                  data-nodrag="1"
                  data-chip={w.id}
                  style={{ left: w.mid.x, top: w.mid.y }}
                  title={chip.title}
                  aria-label={`เส้นส่งคำตอบ ${nameOf(w.link.from)} ไป ${nameOf(w.link.to)}: ${chip.title}`}
                  onClick={() => setMenu(menu?.kind === 'link' && menu.id === w.id ? null : { kind: 'link', id: w.id })}
                >
                  {chip.text}
                </button>
              );
            })}
            {aWires.map((w) => (
              <button
                key={`ac:${w.key}`}
                type="button"
                className={`cv-chip is-ssh${menu?.kind === 'attach' && menu.sessionId === w.sessionId && menu.machineId === w.machineId ? ' is-open' : ''}`}
                data-nodrag="1"
                style={{ left: w.mid.x, top: w.mid.y }}
                title="งานนี้ต่อกับเครื่องนี้ผ่าน SSH — กดเพื่อยกเลิกเชื่อม"
                aria-label={`SSH ${nameOf(w.sessionId)} ไป ${machineById.get(w.machineId)?.name ?? ''}`}
                onClick={() => setMenu(menu?.kind === 'attach' && menu.sessionId === w.sessionId && menu.machineId === w.machineId ? null : { kind: 'attach', sessionId: w.sessionId, machineId: w.machineId })}
              >
                SSH
              </button>
            ))}
          </div>
        )}

        {selectedWire && selectedMid && (
          <button
            type="button"
            className="cv-wire-x"
            data-nodrag="1"
            style={{ left: selectedMid.x, top: selectedMid.y }}
            aria-label="ลบเส้นเชื่อม"
            title="ลบเส้นเชื่อม (Delete)"
            onClick={() => {
              commitPanes(disconnectPane(panesRef.current, selectedWire.paneId));
              setSelWire(null);
            }}
          >
            ×
          </button>
        )}

        <svg className="cv-edges cv-edges-top" aria-hidden="true" focusable="false">
          {wireDrag && <path d={hCurve(wireDrag.from, wireDrag.to)} className="cv-edge cv-wire is-live" />}
        </svg>
      </div>

      {placed.empty && <div className="cv-empty">ไม่พบ session ที่เปิดอยู่</div>}

      {dock && (
        <div className="cv-chrome cv-dock" data-chrome="1" role="group" aria-label="ช่องที่แสดงบนหน้าจอ">
          {dock}
        </div>
      )}
      <div className="cv-chrome cv-zoom" data-chrome="1" role="group" aria-label="ซูมโครงข่าย">
        <button type="button" className="cv-btn" aria-label="ซูมออก" title="ซูมออก" disabled={view.k <= MIN_ZOOM} onClick={() => zoomBy(1 / 1.25)}>
          −
        </button>
        <span className="cv-zoomval" aria-live="off">
          {zoomPct(view.k)}
        </span>
        <button type="button" className="cv-btn" aria-label="ซูมเข้า" title="ซูมเข้า" disabled={view.k >= MAX_ZOOM} onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button
          type="button"
          className="cv-btn"
          aria-label="พอดีหน้าจอ"
          title="พอดีหน้าจอ"
          onClick={() => {
            auto.current = true;
            fit();
          }}
        >
          <FitIcon />
        </button>
        <button type="button" className="cv-btn cv-rearrange" aria-label="จัดเรียงใหม่" title="จัดเรียงใหม่ (ล้างตำแหน่งที่ลากไว้ แล้วจัดไม่ให้ทับกัน)" onClick={relayout}>
          <RearrangeIcon />
        </button>
        <span className="cv-sep" aria-hidden="true" />
        <button type="button" className="cv-btn cv-addpane" aria-label="เพิ่มช่องดูงาน" title="เพิ่มช่องดูงาน (แล้วลากเส้นจากบล็อก AI มาต่อ)" onClick={addEmptyPane}>
          <PaneAddIcon />
          <span>ช่อง</span>
        </button>
        <span className="cv-sep" aria-hidden="true" />
        <button
          type="button"
          className="cv-btn cv-addai"
          aria-label="เพิ่มงาน AI"
          aria-pressed={popover === 'ai'}
          title="เพิ่มงาน AI ใหม่ (เปิดงานใหม่บนเว็บ)"
          onClick={() => setPopover((p) => (p === 'ai' ? null : 'ai'))}
        >
          <AgentIcon size={18} />
          <span>+ AI</span>
        </button>
        <button
          type="button"
          className="cv-btn cv-addmachine"
          aria-label="เพิ่มเครื่อง"
          aria-pressed={popover === 'machine'}
          title="เพิ่มเครื่องอื่นที่สั่งงานผ่าน SSH"
          onClick={() => setPopover((p) => (p === 'machine' ? null : 'machine'))}
        >
          <ComputerIcon size={18} />
          <span>+ เครื่อง</span>
        </button>
        {onToggleSaved && (
          <button type="button" className="cv-btn cv-saved" aria-label="งานที่บันทึกไว้" aria-pressed={savedOpen} title="งานที่บันทึกไว้ (เปิดทำงานต่อวันอื่น)" onClick={onToggleSaved}>
            <ClockIcon />
          </button>
        )}
      </div>

      {popover === 'ai' && (
        <NewAiPopover
          cwds={cwds}
          machines={machines}
          command={command}
          disabledReason={offlineReason}
          onClose={() => setPopover(null)}
          onStarted={(sid) => {
            setPopover(null);
            requestReveal(sid, true);
          }}
        />
      )}
      {popover === 'machine' && (
        <MachineAddPopover
          peers={peers}
          command={command}
          onClose={() => setPopover(null)}
          onAdded={() => setPopover(null)}
        />
      )}

      {menuLink && (
        <LinkMenu
          link={menuLink.link}
          fromName={nameOf(menuLink.link.from)}
          toName={nameOf(menuLink.link.to)}
          x={nudgeCentre(toScreen(menuLink.mid).x, 252, seams, size.w)}
          y={toScreen(menuLink.mid).y + 18}
          command={command}
          onClose={() => setMenu(null)}
        />
      )}
      {menuAttach && menu?.kind === 'attach' && (
        <AttachMenu
          sessionName={nameOf(menu.sessionId)}
          machineName={machineById.get(menu.machineId)?.name ?? ''}
          sessionId={menu.sessionId}
          machineId={menu.machineId}
          x={nudgeCentre(toScreen(menuAttach.mid).x, 252, seams, size.w)}
          y={toScreen(menuAttach.mid).y + 18}
          command={command}
          onClose={() => setMenu(null)}
        />
      )}

      {toast && (
        <div className="cv-toast cv-chrome" data-chrome="1" role="alert" style={{ left: nudgeCentre(toast.x, 340, seams, size.w), top: toast.y }}>
          <span>{toast.text}</span>
          <button type="button" className="cv-pane-x" aria-label="ปิดข้อความ" onClick={() => setToast(null)}>
            <CloseIcon />
          </button>
        </div>
      )}

      {openMachineInfo && (
        <MachineDrawer
          machine={openMachineInfo}
          attachments={attachments}
          sessionName={nameOf}
          command={command}
          onClose={() => setMDrawer(null)}
        />
      )}

      {drawer && (
        <PaneDrawer
          source={drawer.source}
          session={drawerSession}
          sessions={sessions}
          runner={runners?.[drawer.source.sessionId]}
          command={command}
          total={multi ? size.w - seams[seams.length - 1] : size.w}
          closing={drawer.closing}
          onClose={closeDrawer}
          onPin={pinDrawer}
          onConnect={(sid) => openDrawer({ sessionId: sid, agentId: null })}
          onClearAgent={() => openDrawer({ sessionId: drawer.source.sessionId, agentId: null })}
          onFullScreen={onOpenFull}
        />
      )}
    </div>
  );
}
