/**
 * Which visual editor (if any) a project gets — the single gate both the toolbar
 * toggle and the panels derive from. Pure so the decision table is unit-testable.
 *
 * The two editors are mutually exclusive:
 * - `tailwind` — the class-based visual editor (`useVisualEditor`). Requires a
 *   supported framework AND Tailwind actually compiling in the project; class
 *   writes in a plain-CSS project would never compile.
 * - `css` — the code-first cascade editor (`useCssCascadeEditor`) for vanilla-CSS
 *   projects: Astro or Next.js without Tailwind, or plain HTML/CSS. It edits real
 *   `.css` source, so Tailwind projects (utility classes, no hand-authored rules
 *   to speak of) keep the Tailwind editor instead.
 *
 * Note on Next.js: global stylesheets (e.g. `app/globals.css`) resolve and edit
 * fine. CSS Modules do NOT — the build hashes class names (`.title` →
 * `Hero_title__x7f2a`), so locate can't map them back; those rules render
 * read-only with a CSS-Modules explanation (see `cssCascade.ts`).
 */
import type { ProjectType } from './static-server';

export type EditorMode = 'tailwind' | 'css' | null;

export interface EditorGateInput {
  projectType: ProjectType | undefined;
  /** Backend check: Tailwind actually compiles in this project. */
  tailwindActive: boolean;
  /** Vite only: the className resolver indexes `.tsx`/`.jsx`, so Vite must be React. */
  viteUsesReact: boolean;
}

/** True when the project type is one the Tailwind visual editor supports. */
export function isEditorFramework({
  projectType,
  viteUsesReact,
}: Pick<EditorGateInput, 'projectType' | 'viteUsesReact'>): boolean {
  return (
    projectType === 'nextjs' ||
    projectType === 'astro' ||
    projectType === 'shopifytheme' ||
    (projectType === 'vite' && viteUsesReact)
  );
}

/** The editor mode this project qualifies for (before the serverReady gate). */
export function resolveEditorMode(input: EditorGateInput): EditorMode {
  const { projectType, tailwindActive } = input;
  if (isEditorFramework(input) && tailwindActive) return 'tailwind';
  if (
    ((projectType === 'astro' || projectType === 'nextjs') && !tailwindActive) ||
    projectType === 'statichtml'
  ) {
    return 'css';
  }
  return null;
}
