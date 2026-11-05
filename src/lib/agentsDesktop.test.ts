import { describe, expect, it } from 'vitest';
import {
  acceleratorFromEvent,
  acceleratorLabel,
  nameList,
  quickEntryRecipient,
  quitPrompt,
} from './agentsDesktop';
import type { Agent } from './agents';

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent =>
  ({ id, name, isMain: false, hidden: false, ...over }) as Agent;

describe('quitPrompt', () => {
  const bg = { backgroundAvailable: true };

  it('asks nothing extra when nothing would be interrupted', () => {
    expect(quitPrompt({ working: [], waiting: [] }, bg)).toBeNull();
    expect(quitPrompt(null, bg)).toBeNull();
  });

  it('leads with how many are working, then who is waiting', () => {
    const p = quitPrompt({ working: ['Acme Site', 'Native App'], waiting: ['Lead Gen'] }, bg);
    expect(p?.title).toBe('2 agents are still working. Quit anyway?');
    expect(p?.body).toContain('Quitting stops Acme Site and Native App mid-turn');
    expect(p?.body).toContain('Lead Gen is also waiting for your OK.');
    expect(p?.offerBackground).toBe(true);
  });

  it('says one agent in the singular', () => {
    const p = quitPrompt({ working: ['Acme Site'], waiting: [] }, bg);
    expect(p?.title).toBe('1 agent is still working. Quit anyway?');
    expect(p?.body).toContain('what it has done so far stays');
  });

  it('leads with approvals when nothing is working', () => {
    const p = quitPrompt({ working: [], waiting: ['Lead Gen', 'Finance'] }, bg);
    expect(p?.title).toBe('2 agents are waiting for your OK. Quit anyway?');
    expect(p?.body).toBe('Quitting stops Lead Gen and Finance waiting on their approval.');
  });

  it('only offers keep-running where windows can hide', () => {
    const p = quitPrompt({ working: ['A'], waiting: [] }, { backgroundAvailable: false });
    expect(p?.offerBackground).toBe(false);
  });
});

describe('nameList', () => {
  it('reads naturally at every length', () => {
    expect(nameList(['A'])).toBe('A');
    expect(nameList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(nameList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 others');
  });
});

describe('shortcuts', () => {
  const key = (
    code: string,
    mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}
  ) => ({
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  it('records the physical key, in the backend’s order', () => {
    expect(acceleratorFromEvent(key('Space', { altKey: true }))).toBe('Alt+Space');
    expect(acceleratorFromEvent(key('KeyK', { metaKey: true, ctrlKey: true, altKey: true }))).toBe(
      'Ctrl+Alt+Super+KeyK'
    );
  });

  it('waits while only modifiers are down', () => {
    expect(acceleratorFromEvent(key('AltLeft', { altKey: true }))).toBeNull();
    expect(acceleratorFromEvent(key('Enter', { altKey: true }))).toBeNull();
  });

  it('labels like a macOS menu', () => {
    expect(acceleratorLabel('Alt+Space')).toBe('⌥Space');
    expect(acceleratorLabel('Ctrl+Alt+Shift+Super+KeyK')).toBe('⌃⌥⇧⌘K');
    expect(acceleratorLabel('Alt+Comma')).toBe('⌥,');
  });
});

describe('quickEntryRecipient', () => {
  const team = [
    agent('chief', 'Chief of Staff', { isMain: true }),
    agent('acme', 'Acme Site'),
    agent('acmeqa', 'Acme Site QA'),
    agent('fin', 'Finance'),
    agent('secret', 'Hidden One', { hidden: true }),
  ];

  it('goes to the Chief of Staff unless addressed', () => {
    const r = quickEntryRecipient('Book a table', team);
    expect(r.agent?.id).toBe('chief');
    expect(r.text).toBe('Book a table');
    expect(r.addressed).toBe(false);
  });

  it('a leading @Name picks that agent and is taken off the text', () => {
    const r = quickEntryRecipient('@finance chase Northwind', team);
    expect(r.agent?.id).toBe('fin');
    expect(r.text).toBe('chase Northwind');
    expect(r.addressed).toBe(true);
  });

  it('the longest name wins', () => {
    expect(quickEntryRecipient('@Acme Site QA run it', team).agent?.id).toBe('acmeqa');
    expect(quickEntryRecipient('@Acme Site deploy', team).agent?.id).toBe('acme');
  });

  it('a mention later in the text, a partial name or a hidden agent leaves it with the Chief', () => {
    expect(quickEntryRecipient('ask @Finance', team).agent?.id).toBe('chief');
    expect(quickEntryRecipient('@Fin hi', team).agent?.id).toBe('chief');
    expect(quickEntryRecipient('@Hidden One hi', team).agent?.id).toBe('chief');
  });
});
