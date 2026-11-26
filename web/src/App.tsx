import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { AskPopup } from './components/AskPopup';
import { Graph } from './components/Graph';
import { useCharacter } from './useCharacter';
import { FullChat } from './components/FullChat';
import { Header } from './components/Header';
import { NewJobPanel } from './components/NewJobPanel';
import { BoardV2 } from './components/BoardV2';
import { ClipWidget } from './components/ClipWidget';
import { SetupHost } from './components/SetupHost';
import { SessionPane } from './components/SessionPane';
import { SavedWidget } from './components/SavedWidget';
import { Summary } from './components/Summary';
import { Widget } from './components/Widget';
import {
  applyPreset,
  loadLayout,
  saveLayout,
  type PresetName,
  type Rect,
  type StoredLayout,
  type WidgetId,
} from './layout';
import {
  applyPreset2,
  loadLayout2,
  saveLayout2,
  setHidden,
  type PresetName2,
  type StoredLayout2,
  type FloatId2,
} from './layoutV2';
import { resolveUiVersion, saveUiVersion, syncSearch, type UiVersion } from './uiVersion';
import { targetLabel } from './control';
import { askNotifyPermission, loadSound, notifyPermission, playBeep, saveSound, showNotification, type NotifyPermission } from './notify';
import { EMPTY_QUEUE, collectItems, titleWithCount, updateQueue } from './queue';
import { resolvePanes } from './selection';
import { useServer } from './useServer';
import { useSeams } from './canvas/useSeams';
import { useLang, useT, type TKey } from './i18n';
import { AccountsHost } from './components/AccountsHost';
import { AppLockPage } from './components/AppLockPage';

const STACK_QUERY = '(max-width: 899px)';

const TITLE_KEYS: Record<WidgetId, TKey> = {
  graph: 'shell.widget.graph',
  pane1: 'shell.widget.pane1',
  pane2: 'shell.widget.pane2',
  summary: 'shell.widget.summary',
  clip: 'shell.widget.clip',
};

function useStacked(): boolean {
  const [stacked, setStacked] = useState(() => typeof window !== 'undefined' && window.matchMedia(STACK_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(STACK_QUERY);
    const on = () => setStacked(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  return stacked;
}

interface Panes {
  p1: string | null;
  p2: string | null;
}

export function App() {
  useLang(); // re-render the whole tree when the language changes
  const t = useT();
  const server = useServer();
  const stacked = useStacked();

  const [layout, setLayout] = useState<StoredLayout>(() => loadLayout());
  const latest = useRef(layout);
  latest.current = layout;

  // UI version: v1 (graph widget + tiled widgets) or v2 (canvas + floating widgets). Each keeps its own layout.
  const [ui, setUi] = useState<UiVersion>(() => resolveUiVersion(window.location.search));
  const chooseUi = useCallback((v: UiVersion) => {
    setUi(v);
    saveUiVersion(v);
    try {
      const next = syncSearch(window.location.search, v);
      if (next !== window.location.search) window.history.replaceState(null, '', `${window.location.pathname}${next}${window.location.hash}`);
    } catch {
      /* the address bar is a nicety */
    }
  }, []);
  const [layout2, setLayout2] = useState<StoredLayout2>(() => loadLayout2());
  const latest2 = useRef(layout2);
  latest2.current = layout2;

  const [picks, setPicks] = useState<Panes>({ p1: null, p2: null });
  const [sel, setSel] = useState<{ sessionId: string | null; agentId: string | null }>({ sessionId: null, agentId: null });
  const [top, setTop] = useState<WidgetId>('graph');
  const seamState = useSeams();
  const [newOpen, setNewOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ sessionId: string; n: number; open: boolean } | null>(null); // v2: fly the canvas to a session
  const [wanted, setWanted] = useState<string | null>(null); // a just-started job, shown in pane 1 once the watcher sees it

  useEffect(() => {
    if (wanted && server.sessions.some((s) => s.sessionId === wanted)) {
      setPicks((p) => ({ ...p, p1: wanted }));
      setSel({ sessionId: wanted, agentId: null });
      setWanted(null);
    }
  }, [wanted, server.sessions]);

  // ---- stage 3: question queue ----
  const [queue, dispatchQueue] = useReducer(updateQueue, EMPTY_QUEUE);
  // Prompts already waiting when the page first connects are shown but not announced again.
  const baseline = useRef<Set<string> | null>(null);
  useEffect(() => {
    const items = collectItems(server.sessions, server.runners);
    if (baseline.current === null && server.lastMessageAt !== null) baseline.current = new Set(items.map((i) => i.key));
    dispatchQueue(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.sessions, server.runners]);
  const [popupOpen, setPopupOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [notify, setNotify] = useState<NotifyPermission>(() => notifyPermission());
  const [sound, setSound] = useState(() => loadSound());
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const openItem = useCallback((key: string | null) => {
    if (key) setActiveKey(key);
    setPopupOpen(true);
    setFocusToken((n) => n + 1); // the user asked for it (bell / notification): focus may move
  }, []);

  useEffect(() => {
    document.title = titleWithCount('Claude Control Room', queue.items.length);
  }, [queue.items.length]);

  useEffect(() => {
    if (queue.added.length === 0) return;
    setPopupOpen(true); // appears without taking focus
    const fresh = queue.items.filter((i) => queue.added.includes(i.key) && !baseline.current?.has(i.key));
    for (const it of fresh) showNotification(it, (k) => openItem(k));
    if (fresh.length > 0 && soundRef.current) playBeep();
  }, [queue, openItem]);

  useEffect(() => {
    if (queue.items.length === 0) setPopupOpen(false);
  }, [queue.items.length]);

  const char = useCharacter(server.sessions, server.worklog, queue.items.length, server.lastMessageAt !== null);

  const [id1, id2] = resolvePanes(server.sessions, picks.p1, picks.p2);
  // Make the resolved defaults stick, so a pane does not jump when another session arrives.
  useEffect(() => {
    if (id1 !== picks.p1 || id2 !== picks.p2) setPicks({ p1: id1, p2: id2 });
  }, [id1, id2, picks.p1, picks.p2]);

  const session1 = server.sessions.find((s) => s.sessionId === id1) ?? null;
  const session2 = server.sessions.find((s) => s.sessionId === id2) ?? null;

  const fullSession = full ? (server.sessions.find((s) => s.sessionId === full) ?? null) : null;
  const offlineReason = server.demo ? t('shell.conn.demoNoCommand') : server.connected ? null : t('shell.conn.notConnected');
  const titles2: Record<FloatId2, string> = { summary: t(TITLE_KEYS.summary), clip: t(TITLE_KEYS.clip), saved: t('shell.widget.saved') };

  const setRect = useCallback((id: WidgetId, rect: Rect) => {
    setLayout((s) => ({ preset: 'custom', rects: { ...s.rects, [id]: rect } }));
  }, []);

  const commit = useCallback(() => {
    saveLayout(latest.current);
  }, []);

  const choosePreset = useCallback((name: PresetName) => {
    const next = applyPreset(name);
    setLayout(next);
    saveLayout(next);
  }, []);

  const setRect2 = useCallback((id: FloatId2, rect: Rect) => {
    setLayout2((s) => ({ ...s, preset: 'custom', rects: { ...s.rects, [id]: rect } }));
  }, []);
  const commit2 = useCallback(() => {
    saveLayout2(latest2.current);
  }, []);
  const hide2 = useCallback((id: FloatId2, hidden: boolean) => {
    const next = setHidden(latest2.current, id, hidden);
    setLayout2(next);
    saveLayout2(next);
  }, []);
  const choosePreset2 = useCallback((name: PresetName2) => {
    const next = applyPreset2(name);
    setLayout2(next);
    saveLayout2(next);
  }, []);

  const selectNode = (sessionId: string, agentId: string | null) => {
    setPicks((p) => ({ p1: sessionId, p2: p.p2 === sessionId ? p.p1 : p.p2 }));
    setSel({ sessionId, agentId });
  };

  const agentFor = (sessionId: string | null) => (sel.sessionId === sessionId ? sel.agentId : null);

  const pane1El = (
    <SessionPane
      session={session1}
      sessions={server.sessions}
      runner={id1 ? server.runners[id1] : undefined}
      command={server.command}
      onFullScreen={() => id1 && setFull(id1)}
      onPick={(sid) => setPicks((p) => ({ ...p, p1: sid }))}
      selectedAgentId={agentFor(id1)}
      onSelectAgent={(aid) => {
        if (id1) setSel({ sessionId: id1, agentId: aid });
      }}
    />
  );
  const pane2El = (
    <SessionPane
      session={session2}
      sessions={server.sessions}
      runner={id2 ? server.runners[id2] : undefined}
      command={server.command}
      onFullScreen={() => id2 && setFull(id2)}
      onPick={(sid) => setPicks((p) => ({ ...p, p2: sid }))}
      selectedAgentId={agentFor(id2)}
      onSelectAgent={(aid) => {
        if (id2) setSel({ sessionId: id2, agentId: aid });
      }}
    />
  );
  const summaryEl = <Summary sessions={server.sessions} runners={server.runners} cards={server.worklog} ask={server.ask} offlineReason={offlineReason} />;
  const clipEl = <ClipWidget jobs={server.clips} sessions={server.sessions} />;
  const liveIds = useMemo(() => new Set(server.sessions.map((s) => s.sessionId)), [server.sessions]);
  const revealSession = useCallback((sessionId: string, open: boolean) => setReveal((r) => ({ sessionId, n: (r?.n ?? 0) + 1, open })), []);
  const savedEl = (
    <SavedWidget
      saved={server.saved}
      onCanvas={liveIds}
      command={server.command}
      offlineReason={offlineReason}
      onGoto={(sid) => revealSession(sid, false)}
      onResumed={(sid) => revealSession(sid, true)}
    />
  );

  const widget = (id: WidgetId, children: ReactNode, className?: string) => (
    <Widget
      key={id}
      title={t(TITLE_KEYS[id])}
      rect={layout.rects[id]}
      z={top === id ? 3 : 1}
      stacked={stacked}
      className={className}
      onChange={(r) => setRect(id, r)}
      onCommit={commit}
      onRaise={() => setTop(id)}
    >
      {children}
    </Widget>
  );

  // The server refused the socket with the app lock close code: show the lock page until the password is entered.
  if (server.appLocked) {
    return (
      <AppLockPage
        onUnlocked={() => {
          server.clearAppLock();
          window.location.reload();
        }}
      />
    );
  }

  return (
    <div className={`cr-root${stacked ? ' is-stacked' : ''}`}>
    <AccountsHost server={server}>
      <Header
        machine={server.machine}
        connected={server.connected}
        lastMessageAt={server.lastMessageAt}
        demo={server.demo}
        running={server.sessions.filter((s) => s.status === 'running').length}
        waiting={server.sessions.filter((s) => s.status === 'waiting').length}
        preset={ui === 'v2' ? layout2.preset : layout.preset}
        onPreset={ui === 'v2' ? choosePreset2 : choosePreset}
        uiVersion={ui}
        onUiVersion={chooseUi}
        usage={server.usage}
        sessions={server.sessions}
        runners={server.runners}
        selectedSessionId={sel.sessionId}
        onNewJob={() => setNewOpen((o) => !o)}
        newJobOpen={newOpen}
        queueCount={queue.items.length}
        onBell={() => openItem(null)}
        notify={notify}
        onEnableNotify={() => void askNotifyPermission().then(setNotify)}
        sound={sound}
        onToggleSound={() => {
          const next = !sound;
          setSound(next);
          saveSound(next);
          if (next) playBeep();
        }}
      />

      {newOpen && (
        <NewJobPanel
          cwds={server.cwds}
          machines={server.machines}
          command={server.command}
          disabledReason={offlineReason}
          onClose={() => setNewOpen(false)}
          onStarted={(sid) => setWanted(sid)}
        />
      )}

      {ui === 'v2' ? (
        <BoardV2
          seams={seamState.seams}
          windowWidth={seamState.width}
          layout={layout2}
          titles={titles2}
          panes={{ summary: summaryEl, clip: clipEl, saved: savedEl }}
          stacked={stacked}
          onRect={setRect2}
          onCommit={commit2}
          onHidden={hide2}
          canvas={{
            machine: server.machine ?? '—',
            sessions: server.sessions,
            runners: server.runners,
            selectedSessionId: sel.sessionId,
            selectedAgentId: sel.agentId,
            onSelect: selectNode,
            onOpenFull: setFull,
            char,
            onCharClick: () => openItem(null),
            command: server.command,
            links: server.links,
            machines: server.machines,
            attachments: server.attachments,
            peers: server.peers,
            cwds: server.cwds,
            offlineReason,
            savedOpen: !layout2.hidden.saved,
            onToggleSaved: () => hide2('saved', !latest2.current.hidden.saved),
            reveal,
          }}
        />
      ) : (
      <main className="cr-board" data-board="1">
        {widget(
          'graph',
          <Graph
            machine={server.machine ?? '—'}
            machines={server.machines}
            sessions={server.sessions}
            runners={server.runners}
            selectedSessionId={sel.sessionId}
            selectedAgentId={sel.agentId}
            onSelect={selectNode}
            char={char}
            onCharClick={() => openItem(null)}
          />,
          'cr-w--graph',
        )}
        {widget('pane1', pane1El)}
        {widget('pane2', pane2El)}
        {widget('summary', summaryEl)}
        {widget('clip', clipEl)}
      </main>
      )}

      <AskPopup
        items={queue.items}
        activeKey={activeKey}
        open={popupOpen}
        focusToken={focusToken}
        command={server.command}
        sessionLabel={(sid) => {
          const s = server.sessions.find((x) => x.sessionId === sid);
          return s ? targetLabel(s) : sid.slice(0, 8);
        }}
        onActive={setActiveKey}
        onClose={() => setPopupOpen(false)}
      />

      {fullSession && (
        <FullChat
          session={fullSession}
          runner={server.runners[fullSession.sessionId]}
          command={server.command}
          onClose={() => setFull(null)}
        />
      )}
      <SetupHost />
    </AccountsHost>
    </div>
  );
}
