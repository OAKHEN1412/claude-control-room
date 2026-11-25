// "สไตล์เดิมของเรา": clip workflows that already exist on this machine. Each one names the project folder whose
// workflow files a new clip copies, and where to look for a finished render to take a sample still from (first
// existing file wins). The list is user data: it is read once at module load from <dataDir>/our-styles.json
// (a JSON array of OurStyle). A missing or unreadable file gives an empty list; invalid entries are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './cmdlog';

export interface OurStyle {
  id: string;
  name: string;
  note: string;
  sourceDir: string; // project to copy the workflow from
  workflowFiles: string[]; // files / folders inside sourceDir that carry the workflow + style rules
  extraRules: string[]; // style-specific rules for the brief
  renders: string[]; // candidate render files for the sample still
  alt: string;
  noSubagents?: boolean; // true: the brief forbids subagents (the whole clip is written and built in one session)
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function toOurStyle(v: unknown): OurStyle | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  for (const k of ['id', 'name', 'note', 'sourceDir', 'alt'] as const) if (typeof o[k] !== 'string') return null;
  if ((o.id as string).trim() === '') return null;
  for (const k of ['workflowFiles', 'extraRules', 'renders'] as const) if (!isStrings(o[k])) return null;
  return {
    id: o.id as string,
    name: o.name as string,
    note: o.note as string,
    sourceDir: o.sourceDir as string,
    workflowFiles: o.workflowFiles as string[],
    extraRules: o.extraRules as string[],
    renders: o.renders as string[],
    alt: o.alt as string,
    ...(typeof o.noSubagents === 'boolean' ? { noSubagents: o.noSubagents } : {}),
  };
}

/** Reads `<dir>/our-styles.json`. Never throws: missing file or bad JSON gives []; invalid entries are skipped. */
export function loadOurStyles(dir: string = dataDir()): OurStyle[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'our-styles.json'), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(toOurStyle).filter((s): s is OurStyle => s !== null);
  } catch {
    return [];
  }
}

export const OUR_STYLES: readonly OurStyle[] = loadOurStyles();

export function ourStyleById(id: string): OurStyle | undefined {
  return OUR_STYLES.find((s) => s.id === id);
}
