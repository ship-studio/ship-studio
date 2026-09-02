import { describe, expect, it } from 'vitest';
import { containerDotState, containerLabel, containerMeta, isContainerRunning } from './containers';

describe('isContainerRunning', () => {
  it('treats running and restarting as running', () => {
    expect(isContainerRunning({ state: 'running' })).toBe(true);
    expect(isContainerRunning({ state: 'restarting' })).toBe(true);
    expect(isContainerRunning({ state: 'exited' })).toBe(false);
    expect(isContainerRunning({ state: 'created' })).toBe(false);
  });
});

describe('containerLabel', () => {
  it('prefers the compose service name over the container name', () => {
    expect(containerLabel({ name: 'myapp-db-1', service: 'db' })).toBe('db');
  });

  it('falls back to the container name without a service label', () => {
    expect(containerLabel({ name: 'vsc-myapp-abc', service: null })).toBe('vsc-myapp-abc');
  });
});

describe('containerDotState', () => {
  it('maps engine states to sidebar dot vocabulary', () => {
    expect(containerDotState('running')).toBe('active');
    expect(containerDotState('restarting')).toBe('attention');
    expect(containerDotState('paused')).toBe('idle');
    expect(containerDotState('exited')).toBe('muted');
    expect(containerDotState('created')).toBe('muted');
    expect(containerDotState('dead')).toBe('muted');
  });
});

describe('containerMeta', () => {
  it('shows published host ports for running containers', () => {
    expect(
      containerMeta({
        state: 'running',
        ports: [
          { hostPort: 5432, containerPort: 5432, protocol: 'tcp' },
          { hostPort: 6379, containerPort: 6379, protocol: 'tcp' },
        ],
      })
    ).toBe(':5432 :6379');
  });

  it('shows nothing for a running container without published ports', () => {
    expect(containerMeta({ state: 'running', ports: [] })).toBeUndefined();
  });

  it('shows the engine state for non-running containers', () => {
    expect(containerMeta({ state: 'exited', ports: [] })).toBe('exited');
    expect(
      containerMeta({
        state: 'paused',
        ports: [{ hostPort: 3000, containerPort: 3000, protocol: 'tcp' }],
      })
    ).toBe('paused');
  });
});
