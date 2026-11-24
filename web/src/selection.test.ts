import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../../shared/protocol';
import { resolvePanes } from './selection';

const s = (id: string, status: SessionInfo['status']): Pick<SessionInfo, 'sessionId' | 'status'> =>
  ({ sessionId: id, status }) as Pick<SessionInfo, 'sessionId' | 'status'>;

describe('resolvePanes', () => {
  const list = [s('idle1', 'idle'), s('run1', 'running'), s('wait1', 'waiting'), s('done1', 'done')] as SessionInfo[];

  it('defaults to the first two running/waiting sessions', () => {
    expect(resolvePanes(list, null, null)).toEqual(['run1', 'wait1']);
  });

  it('keeps a picked session that still exists', () => {
    expect(resolvePanes(list, 'done1', null)).toEqual(['done1', 'run1']);
  });

  it('falls back to the default when a picked session has gone', () => {
    expect(resolvePanes(list, 'gone', 'wait1')).toEqual(['run1', 'wait1']);
  });

  it('leaves a pane empty when there is nothing active to show', () => {
    expect(resolvePanes([s('idle1', 'idle')] as SessionInfo[], null, null)).toEqual([null, null]);
  });
});
