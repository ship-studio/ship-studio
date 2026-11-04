import { describe, expect, it } from 'vitest';
import { appManagedWhere, appStatusLabel, appTarget, appTitle } from './agentApps';

describe('agent apps wording', () => {
  it('names a claude.ai connector by the app, and a server by its own name', () => {
    expect(appTitle({ name: 'claude.ai Google Drive', source: 'claudeAi' })).toBe('Google Drive');
    expect(appTitle({ name: 'figma', source: 'user' })).toBe('figma');
  });

  it('shows a URL as its host and a command as written', () => {
    expect(appTarget('https://mcp.figma.com/mcp')).toBe('mcp.figma.com');
    expect(appTarget('npx @playwright/mcp@latest')).toBe('npx @playwright/mcp@latest');
  });

  it('only words statuses Claude Code actually reported', () => {
    expect(appStatusLabel('needs_auth')).toBe('Needs sign-in');
    expect(appStatusLabel('unknown')).toBeNull();
  });

  it('says where an app it cannot remove is managed', () => {
    expect(appManagedWhere('user')).toBeNull();
    expect(appManagedWhere('claudeAi')).toBe('Managed on claude.ai');
  });
});
