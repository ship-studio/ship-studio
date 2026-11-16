import { describe, expect, it } from 'vitest';
import { remoteStep, type RemoteRequest } from './useRemoteAgentControl';

const start: RemoteRequest = {
  kind: 'start',
  projectPath: '/p',
  prompt: 'fix the header',
  sessionId: 'new',
  receivedAt: 1_000,
};
const close: RemoteRequest = {
  kind: 'close',
  projectPath: '/p',
  sessionId: 'b',
  receivedAt: 1_000,
};
const tabs = [
  { id: 1, sessionId: 'a' },
  { id: 2, sessionId: 'b' },
];
const ready = {
  currentProjectPath: '/p',
  inWorkspace: true,
  terminalTabs: tabs,
  maxTerminalTabs: 6,
};

describe('remoteStep', () => {
  it('does nothing without a request', () => {
    expect(remoteStep(null, ready, 2_000)).toEqual({ do: 'idle' });
  });

  it('waits while another project is showing, the dashboard is up, or tabs are not seeded', () => {
    expect(remoteStep(start, { ...ready, currentProjectPath: '/other' }, 2_000)).toEqual({
      do: 'wait',
    });
    expect(remoteStep(close, { ...ready, inWorkspace: false }, 2_000)).toEqual({ do: 'wait' });
    expect(remoteStep(start, { ...ready, terminalTabs: [] }, 2_000)).toEqual({ do: 'wait' });
  });

  it('gives up rather than act on a stale request', () => {
    expect(remoteStep(start, { ...ready, inWorkspace: false }, 62_000)).toEqual({
      do: 'drop',
      reason: 'expired',
    });
  });

  it('starts once ready, unless the project is out of tab room', () => {
    expect(remoteStep(start, ready, 2_000)).toEqual({ do: 'start' });
    expect(remoteStep(start, { ...ready, maxTerminalTabs: 2 }, 2_000)).toEqual({
      do: 'drop',
      reason: 'no_room',
    });
  });

  it('closes the tab whose session matches', () => {
    expect(remoteStep(close, ready, 2_000)).toEqual({ do: 'close', tabId: 2 });
  });

  it('never closes the last tab or a tab that is not there', () => {
    expect(remoteStep(close, { ...ready, terminalTabs: [tabs[1]] }, 2_000)).toEqual({
      do: 'drop',
      reason: 'last_tab',
    });
    expect(remoteStep({ ...close, sessionId: 'zzz' }, ready, 2_000)).toEqual({
      do: 'drop',
      reason: 'no_such_tab',
    });
  });

  it('shows a project once it is the one in the workspace, tabs or not', () => {
    const show: RemoteRequest = { kind: 'show', projectPath: '/p', receivedAt: 1_000 };
    expect(remoteStep(show, { ...ready, currentProjectPath: '/other' }, 2_000)).toEqual({
      do: 'wait',
    });
    expect(remoteStep(show, { ...ready, terminalTabs: [] }, 2_000)).toEqual({ do: 'shown' });
  });
});
