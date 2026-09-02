#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const COMPONENTS_ROOT = join(process.cwd(), 'src/components');

const rules = [
  { label: 'role="dialog"', pattern: /role\s*=\s*["']dialog["']/g },
  { label: 'modal-overlay class', pattern: /(?<![\w-])modal-overlay(?![\w-])/g },
  { label: 'create-modal-overlay class', pattern: /\bcreate-modal-overlay\b/g },
  { label: 'env-paste-overlay class', pattern: /\benv-paste-overlay\b/g },
  {
    label: 'onboarding-terminal-overlay class',
    pattern: /\bonboarding-terminal-overlay\b/g,
  },
];

const allowlist = [
  {
    file: 'src/components/primitives/ModalFrame.tsx',
    label: 'role="dialog"',
    reason: 'canonical dialog primitive implementation',
  },
  {
    file: 'src/components/branches/BranchIndicator.tsx',
    label: 'role="dialog"',
    reason: 'anchored branch-status popover; modal migration would change its placement contract',
  },
  {
    file: 'src/components/edit/ColorPicker.tsx',
    label: 'role="dialog"',
    reason: 'dockable editor panel; it is not a modal surface',
  },
  {
    file: 'src/components/edit/InsertMenu.tsx',
    label: 'role="dialog"',
    reason: 'anchored insertion menu; it is a future menu/listbox contract',
  },
  {
    file: 'src/components/edit/InheritancePopover.tsx',
    label: 'role="dialog"',
    reason:
      'anchored provenance popover inside the editor panel; it is not a modal surface and must not trap focus',
  },
  {
    file: 'src/components/preview/PreviewSizeControl.tsx',
    label: 'role="dialog"',
    reason: 'anchored preview-size popover; it is not a modal surface',
  },
  {
    file: 'src/components/workspace/EnvEditor.tsx',
    label: 'env-paste-overlay class',
    reason: 'nested paste flow retained for the EnvEditor follow-up',
  },
  {
    file: 'src/components/dashboard/CreateProject.tsx',
    label: 'create-modal-overlay class',
    reason: 'multi-step creation flow retained for its dedicated migration',
  },
  {
    file: 'src/components/dashboard/ImportProject.tsx',
    label: 'create-modal-overlay class',
    reason: 'multi-step import flow retained for its dedicated migration',
  },
  {
    file: 'src/components/dashboard/ProjectsView.tsx',
    label: 'onboarding-terminal-overlay class',
    reason: 'interactive terminal surface retained for the onboarding-terminal migration',
  },
  {
    file: 'src/components/setup/OnboardingScreen.tsx',
    label: 'onboarding-terminal-overlay class',
    reason: 'interactive terminal surface retained for the onboarding-terminal migration',
  },
  {
    file: 'src/components/setup/agent-led/AgentOnboardingScreen.tsx',
    label: 'onboarding-terminal-overlay class',
    reason: 'interactive terminal surface retained for the onboarding-terminal migration',
  },
  {
    file: 'src/components/workspace/WorkspaceModals.tsx',
    label: 'onboarding-terminal-overlay class',
    reason: 'interactive terminal surface retained for the onboarding-terminal migration',
  },
];

function listTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

const allowlistedFindings = new Map(
  allowlist.map((entry) => [`${entry.file}:${entry.label}`, entry.reason])
);
const violations = [];
const approved = [];

for (const file of listTypeScriptFiles(COMPONENTS_ROOT)) {
  const source = readFileSync(file, 'utf8');
  const relativeFile = relative(process.cwd(), file);

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      const key = `${relativeFile}:${rule.label}`;
      const reason = allowlistedFindings.get(key);
      const finding = `${relativeFile}:${lineNumber(source, match.index ?? 0)} (${rule.label})`;
      if (reason) approved.push(`${finding} — ${reason}`);
      else violations.push(finding);
    }
  }
}

for (const finding of approved) console.log(`  ${finding}`);

if (violations.length > 0) {
  console.error('  Unapproved dialog/overlay recipes found:');
  for (const finding of violations) {
    console.error(`    ${finding}`);
  }
  console.error(
    '  Use ModalFrame, or add a narrowly scoped allowlist entry with a reason for a non-modal/follow-up surface.'
  );
  process.exitCode = 1;
} else {
  console.log('  Component dialog/overlay recipe scan — ok');
}
