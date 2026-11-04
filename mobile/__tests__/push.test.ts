import type { NotificationResponse } from 'expo-notifications';
import { agentFromResponse, pushLine } from '../src/lib/push';

const response = (content: unknown, trigger: unknown) =>
  ({ notification: { request: { content: { data: content }, trigger } } }) as NotificationResponse;

describe('agentFromResponse', () => {
  it('reads a local alert, an APNs push and an FCM push', () => {
    expect(agentFromResponse(response({ agentId: 'a1' }, null))).toBe('a1');
    expect(
      agentFromResponse(response(undefined, { type: 'push', payload: { body: { agentId: 'a2' } } }))
    ).toBe('a2');
    expect(
      agentFromResponse(response({}, { type: 'push', remoteMessage: { data: { agentId: 'a3' } } }))
    ).toBe('a3');
  });

  it('is null for anything else', () => {
    expect(agentFromResponse(null)).toBeNull();
    expect(agentFromResponse(response({ agentId: 7 }, null))).toBeNull();
  });
});

describe('pushLine', () => {
  it('a self-built app says push needs the official build, whatever the Mac says', () => {
    expect(pushLine(null, false)?.value).toBe('Needs the official build');
    expect(pushLine('on', false)?.value).toBe('Needs the official build');
    expect(pushLine('self_build', true)?.value).toBe('Needs the official build');
  });

  it('says what the Mac answered, and nothing before it has', () => {
    expect(pushLine(null, true)).toBeNull();
    expect(pushLine('on', true)?.footer).toMatch(/never what it said/);
    expect(pushLine('off', true)?.value).toBe('Off on your Mac');
    expect(pushLine('unavailable', true)?.value).toBe('Not on this Mac');
    expect(pushLine('pending', true)?.value).toBe('Connecting');
  });
});
