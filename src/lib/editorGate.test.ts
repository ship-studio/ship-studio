import { describe, expect, it } from 'vitest';
import { isEditorFramework, resolveEditorMode } from './editorGate';
import type { ProjectType } from './static-server';

const gate = (
  projectType: ProjectType | undefined,
  tailwindActive: boolean,
  viteUsesReact = false
) => resolveEditorMode({ projectType, tailwindActive, viteUsesReact });

describe('resolveEditorMode', () => {
  it('gives Next.js WITH Tailwind the Tailwind editor (never the CSS editor)', () => {
    expect(gate('nextjs', true)).toBe('tailwind');
  });

  it('gives Next.js WITHOUT Tailwind the code-first CSS editor', () => {
    expect(gate('nextjs', false)).toBe('css');
  });

  it('keeps the existing Astro split: Tailwind → tailwind, vanilla → css', () => {
    expect(gate('astro', true)).toBe('tailwind');
    expect(gate('astro', false)).toBe('css');
  });

  it('always gives plain HTML projects the CSS editor', () => {
    expect(gate('statichtml', false)).toBe('css');
  });

  it('gates Vite on React and on Tailwind, and never offers Vite the CSS editor', () => {
    expect(gate('vite', true, true)).toBe('tailwind');
    expect(gate('vite', true, false)).toBeNull();
    expect(gate('vite', false, true)).toBeNull();
  });

  it('offers Shopify themes only the Tailwind editor', () => {
    expect(gate('shopifytheme', true)).toBe('tailwind');
    expect(gate('shopifytheme', false)).toBeNull();
  });

  it('offers nothing when the project type is unknown', () => {
    expect(gate(undefined, false)).toBeNull();
    expect(gate(undefined, true)).toBeNull();
  });

  it('never selects both editors for the same input (mutual exclusivity)', () => {
    const types: (ProjectType | undefined)[] = [
      'nextjs',
      'astro',
      'vite',
      'statichtml',
      'shopifytheme',
      undefined,
    ];
    for (const projectType of types) {
      for (const tailwindActive of [true, false]) {
        for (const viteUsesReact of [true, false]) {
          const mode = resolveEditorMode({ projectType, tailwindActive, viteUsesReact });
          expect([null, 'tailwind', 'css']).toContain(mode);
        }
      }
    }
  });
});

describe('isEditorFramework', () => {
  it('accepts the class-resolver frameworks and rejects the rest', () => {
    expect(isEditorFramework({ projectType: 'nextjs', viteUsesReact: false })).toBe(true);
    expect(isEditorFramework({ projectType: 'astro', viteUsesReact: false })).toBe(true);
    expect(isEditorFramework({ projectType: 'shopifytheme', viteUsesReact: false })).toBe(true);
    expect(isEditorFramework({ projectType: 'vite', viteUsesReact: true })).toBe(true);
    expect(isEditorFramework({ projectType: 'vite', viteUsesReact: false })).toBe(false);
    expect(isEditorFramework({ projectType: 'statichtml', viteUsesReact: false })).toBe(false);
    expect(isEditorFramework({ projectType: undefined, viteUsesReact: false })).toBe(false);
  });
});
