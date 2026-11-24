// Attachments of one message box: chips, uploads, drag & drop onto the box (and the pane around it) and paste.
import { useCallback, useEffect, useReducer, useRef, useState, type ClipboardEvent } from 'react';
import { chipsReducer, dragHasFiles, extractFiles, isUploading, pastedName, planAdd, readyIds, uploadFile, type Chip } from '../attach';
import { apiBase } from '../useServer';

export interface Attachments {
  chips: Chip[];
  ids: string[]; // uploaded, ready to send
  uploading: boolean;
  problem: string | null; // last thing refused (too big, too many, attaching switched off)
  dragging: boolean; // a file is being dragged over the box
  disabled: string | null; // Thai reason attaching is off, or null
  addFiles(files: File[]): void;
  remove(key: string): void;
  clear(): void;
  /** onPaste of the text box: takes pasted files / screenshots, lets plain text paste through. */
  onPaste(e: ClipboardEvent<HTMLElement>): void;
  /** ref callback of the element that is the drop target (its nearest [data-drop-host] ancestor also takes drops). */
  bindHost(el: HTMLElement | null): void;
}

export function useAttachments(opts: { disabledReason?: string | null } = {}): Attachments {
  const disabled = opts.disabledReason ?? null;
  const [chips, dispatch] = useReducer(chipsReducer, []);
  const chipsRef = useRef<Chip[]>(chips);
  chipsRef.current = chips;
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const seq = useRef(0);
  const urls = useRef(new Set<string>());
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const revoke = (url?: string) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  };
  useEffect(() => {
    const set = urls.current;
    return () => {
      for (const u of set) URL.revokeObjectURL(u);
      set.clear();
    };
  }, []);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    if (disabledRef.current) {
      setProblem(disabledRef.current);
      return;
    }
    const now = new Date();
    const named = files.map((f, i) => ({ file: f, name: pastedName(f, now, i) }));
    const plan = planAdd(chipsRef.current, named.map((n) => ({ name: n.name, size: n.file.size })));
    setProblem(plan.problems.length > 0 ? plan.problems.join(' · ') : null);
    const base = apiBase();
    const fresh: Chip[] = plan.accept.map((i) => {
      const { file, name } = named[i];
      const key = `a${Date.now().toString(36)}-${++seq.current}`;
      let previewUrl: string | undefined;
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
        previewUrl = URL.createObjectURL(file);
        urls.current.add(previewUrl);
      }
      return { key, name, size: file.size, mime: file.type, status: 'uploading', previewUrl };
    });
    if (fresh.length === 0) return;
    dispatch({ type: 'add', chips: fresh });
    fresh.forEach((chip, n) => {
      const { file } = named[plan.accept[n]];
      uploadFile(file, chip.name, base).then(
        (u) => dispatch({ type: 'done', key: chip.key, id: u.id, name: u.name }),
        (e: unknown) => dispatch({ type: 'fail', key: chip.key, error: e instanceof Error ? e.message : 'อัปโหลดไม่สำเร็จ' }),
      );
    });
  }, []);

  const remove = useCallback((key: string) => {
    revoke(chipsRef.current.find((c) => c.key === key)?.previewUrl);
    dispatch({ type: 'remove', key });
    setProblem(null);
  }, []);

  const clear = useCallback(() => {
    for (const c of chipsRef.current) revoke(c.previewUrl);
    dispatch({ type: 'clear' });
    setProblem(null);
  }, []);

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLElement>) => {
      const files = extractFiles(e.clipboardData);
      if (files.length === 0) return; // plain text: let the box handle it
      e.preventDefault();
      addFiles(files);
    },
    [addFiles],
  );

  // Drag & drop: on the box, and on the pane around it when the box sits inside a [data-drop-host].
  useEffect(() => {
    if (!host) return;
    const target = host.closest<HTMLElement>('[data-drop-host]') ?? host;
    let depth = 0;
    const on = (v: boolean) => {
      setDragging(v);
      target.classList.toggle('is-dropping', v);
    };
    const enter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth += 1;
      on(true);
    };
    const over = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault(); // without this the browser would open the file instead of dropping it
      if (e.dataTransfer) e.dataTransfer.dropEffect = disabledRef.current ? 'none' : 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) on(false);
    };
    const drop = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      on(false);
      addFiles(extractFiles(e.dataTransfer));
    };
    target.addEventListener('dragenter', enter);
    target.addEventListener('dragover', over);
    target.addEventListener('dragleave', leave);
    target.addEventListener('drop', drop);
    return () => {
      target.removeEventListener('dragenter', enter);
      target.removeEventListener('dragover', over);
      target.removeEventListener('dragleave', leave);
      target.removeEventListener('drop', drop);
      target.classList.remove('is-dropping');
    };
  }, [host, addFiles]);

  return {
    chips,
    ids: readyIds(chips),
    uploading: isUploading(chips),
    problem,
    dragging,
    disabled,
    addFiles,
    remove,
    clear,
    onPaste,
    bindHost: setHost,
  };
}
