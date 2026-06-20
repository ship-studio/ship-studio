/**
 * Hook that owns all project-creation logic for the CreateProject wizard —
 * state, side effects, and handlers — so the component only renders.
 *
 * Two-step form (`formStep`): pick a source ('select-template': a built-in
 * `TEMPLATES` entry, or a .zip via browser file picker / Tauri drag-drop) →
 * 'enter-name'. Then the creation pipeline (`currentStep`, mirrored by the
 * progress UI via `getStepStatus`): clone (`git clone` through a `spawn_pty`
 * PTY; zips go through `extract_template_zip`; blank uses
 * `create_blank_project`) → init (`remove_git_history` so the project
 * detaches from the template repo, gitignore `.shipstudio/`, fire-and-forget
 * Vercel plugin install) → install (`npm install` via PTY, gated on an npm
 * cache-permission pre-check) → done → `onComplete(projectPath)`, which the
 * caller turns into a project open. `retryInstall` re-runs just the install
 * step against `createdProjectPath`.
 *
 * Consumed solely by `components/dashboard/CreateProject.tsx`.
 *
 * Boundaries: `spawn_pty` + the `pty-output`/`pty-exit` events (exit codes
 * mapped to friendly errors: 243 npm cache, 128 git auth, 69 Xcode license),
 * `list_projects` (duplicate-name check), `ensure_shipstudio_dir`,
 * lib/setup (`checkNpmCachePermissions`), lib/plugins.
 *
 * Gotchas: `waitForPtyExit` treats a `null` exit code (process killed) as
 * SUCCESS, so a killed clone/install proceeds to the next step. The two zip
 * sources are mutually exclusive (`zipFile` from the browser vs `zipPath`
 * from Tauri drag-drop — selecting one clears the other), and the native
 * drag-drop listeners are only attached on the select-template step while
 * not creating.
 *
 * @module hooks/useProjectCreation
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { trackError } from '../lib/analytics';
import { getWindowLabel } from '../lib/window';
import { checkNpmCachePermissions } from '../lib/setup';
import { installPlugin, VERCEL_PLUGIN_REPO } from '../lib/plugins';

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

/** Grouping for the template picker, so the grid isn't an undifferentiated list. */
export type TemplateCategory = 'web' | 'mobile' | 'other';

/** Template definition for project scaffolding */
export interface Template {
  /** Unique identifier for the template */
  id: string;
  /** Display name */
  name: string;
  /** Short description of what the template includes */
  description: string;
  /** GitHub repository URL to clone */
  repo: string;
  /** Which section of the picker this template appears under */
  category: TemplateCategory;
  /** Skip the npm install step (templates with no package.json, e.g. HTML/Flutter) */
  skipInstall?: boolean;
}

const DEFAULT_TEMPLATE_KEY = 'defaultTemplateId';

function getDefaultTemplate(): Template {
  const stored = localStorage.getItem(DEFAULT_TEMPLATE_KEY);
  if (stored) {
    const found = TEMPLATES.find((t) => t.id === stored);
    if (found) return found;
  }
  return TEMPLATES[0]; // Next.js
}

/** Available project templates */
export const TEMPLATES: Template[] = [
  {
    id: 'nextjs-basic',
    name: 'Next.js',
    description: 'A modern website. A great default if you are not sure.',
    repo: 'https://github.com/ship-studio/static-marketing-site-starter',
    category: 'web',
  },
  {
    id: 'sveltekit-basic',
    name: 'SvelteKit',
    description: 'A fast, lightweight website.',
    repo: 'https://github.com/ship-studio/sveltekit-static-marketing-site-starter',
    category: 'web',
  },
  {
    id: 'astro-basic',
    name: 'Astro',
    description: 'A content or marketing site that loads fast.',
    repo: 'https://github.com/ship-studio/astro-static-marketing-site-starter',
    category: 'web',
  },
  {
    id: 'nuxt-basic',
    name: 'Nuxt',
    description: 'A website built on Vue.',
    repo: 'https://github.com/ship-studio/nuxt-static-marketing-site-starter',
    category: 'web',
  },
  {
    id: 'html-basic',
    name: 'HTML/CSS/JS',
    description: 'A plain website with no framework or build step.',
    repo: 'https://github.com/ship-studio/html-starter',
    category: 'web',
    skipInstall: true,
  },
  {
    id: 'expo-mobile',
    name: 'Expo',
    description: 'An iOS and Android app. The easiest mobile path.',
    repo: 'https://github.com/ship-studio/expo-starter',
    category: 'mobile',
  },
  {
    id: 'react-native-mobile',
    name: 'React Native',
    description: 'An iOS and Android app with full native control.',
    repo: 'https://github.com/ship-studio/react-native-starter',
    category: 'mobile',
  },
  {
    id: 'flutter-mobile',
    name: 'Flutter',
    description: 'An iOS and Android app built with Flutter.',
    repo: 'https://github.com/ship-studio/flutter-starter',
    category: 'mobile',
    skipInstall: true,
  },
  {
    id: 'shopify-theme',
    name: 'Shopify Theme',
    description: 'An online store theme that previews against your real store.',
    repo: 'https://github.com/ship-studio/shopify-theme-starter',
    category: 'other',
    skipInstall: true,
  },
  {
    id: 'blank',
    name: 'Blank Project',
    description: 'An empty folder. Start completely from scratch.',
    repo: '',
    category: 'other',
  },
];

/** Picker sections, in display order. */
export const TEMPLATE_GROUPS: { id: TemplateCategory; label: string }[] = [
  { id: 'web', label: 'Websites & web apps' },
  { id: 'mobile', label: 'Mobile apps' },
  { id: 'other', label: 'Other' },
];

/** Form wizard steps before creation starts */
export type FormStep = 'select-template' | 'enter-name';

/** Creation progress steps */
export type Step = 'clone' | 'init' | 'install' | 'done';

/** Step definitions with display labels */
export const STEPS: { id: Step; label: string }[] = [
  { id: 'clone', label: 'Clone template' },
  { id: 'init', label: 'Initialize project' },
  { id: 'install', label: 'Install dependencies' },
  { id: 'done', label: 'Done' },
];

/** User-facing status messages for each creation step */
export const STATUS_MESSAGES: Record<Step, string> = {
  clone: 'Downloading template...',
  init: 'Setting up project...',
  install: 'Installing dependencies... This may take a minute.',
  done: 'Almost done...',
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseProjectCreationParams {
  onComplete: (projectPath: string) => void;
  onCancel: () => void;
}

export function useProjectCreation({ onComplete, onCancel }: UseProjectCreationParams) {
  // ---- State ----
  const [formStep, setFormStep] = useState<FormStep>('select-template');
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(getDefaultTemplate());
  const [projectName, setProjectName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [currentStep, setCurrentStep] = useState<Step>('clone');
  const [error, setError] = useState<string | null>(null);
  const [createdProjectPath, setCreatedProjectPath] = useState<string | null>(null);

  // Template zip state
  const [zipFile, setZipFile] = useState<File | null>(null); // From browser file picker
  const [zipPath, setZipPath] = useState<string | null>(null); // From Tauri drag-drop
  const [zipFileName, setZipFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ---- Refs ----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // ---- Computed values ----
  const hasZipTemplate = zipFile || zipPath;
  const displayZipName = zipFile?.name || zipFileName;

  // ---- Tauri drag-drop listener effect ----
  useEffect(() => {
    if (formStep !== 'select-template' || isCreating) return;

    let unlistenDrop: (() => void) | null = null;
    let unlistenOver: (() => void) | null = null;
    let unlistenLeave: (() => void) | null = null;

    const setupListeners = async () => {
      // Listen for file drop
      unlistenDrop = await listen<{ paths: string[]; position: { x: number; y: number } }>(
        'tauri://drag-drop',
        (event) => {
          if (event.payload.paths && event.payload.paths.length > 0) {
            const path = event.payload.paths[0];
            if (path.endsWith('.zip')) {
              const fileName = path.split('/').pop() || 'template.zip';
              setZipPath(path);
              setZipFileName(fileName);
              setZipFile(null); // Clear browser File object
              setSelectedTemplate(null);
              setError(null);
            } else {
              setError('Please drop a .zip file');
            }
          }
          setIsDragging(false);
        }
      );

      // Listen for drag-over to show visual feedback
      unlistenOver = await listen('tauri://drag-over', () => {
        setIsDragging(true);
      });

      unlistenLeave = await listen('tauri://drag-leave', () => {
        setIsDragging(false);
      });
    };

    void setupListeners();

    return () => {
      unlistenDrop?.();
      unlistenOver?.();
      unlistenLeave?.();
    };
  }, [formStep, isCreating]);

  // ---- Helpers ----

  const waitForPtyExit = async (targetId: number): Promise<number | null> => {
    return new Promise((resolve, reject) => {
      let unlistenExit: UnlistenFn | null = null;
      let unlistenOutput: UnlistenFn | null = null;
      const outputLines: string[] = [];
      const MAX_OUTPUT_LINES = 30;

      // Capture process output so we can surface it on failure
      void listen<{ id: number; data: string }>('pty-output', (event) => {
        if (event.payload.id === targetId) {
          const lines = event.payload.data.split(/\r?\n/).filter((l) => l.trim());
          for (const line of lines) {
            outputLines.push(line);
            if (outputLines.length > MAX_OUTPUT_LINES) outputLines.shift();
          }
        }
      }).then((fn) => {
        unlistenOutput = fn;
      });

      void listen<{ id: number; code: number | null }>('pty-exit', (event) => {
        if (event.payload.id === targetId) {
          unlistenExit?.();
          unlistenOutput?.();
          if (event.payload.code === 0 || event.payload.code === null) {
            resolve(event.payload.code);
          } else {
            const output = outputLines.join('\n').trim();
            const msg = output
              ? `Process exited with code ${event.payload.code}\n\n${output}`
              : `Process exited with code ${event.payload.code}`;
            reject(new Error(msg));
          }
        }
      }).then((fn) => {
        unlistenExit = fn;
      });
    });
  };

  /** Map PTY exit codes to user-friendly error messages */
  const getFriendlyError = (err: unknown): string => {
    const msg = String(err);
    const codeMatch = msg.match(/Process exited with code (\d+)/);
    if (codeMatch) {
      const code = parseInt(codeMatch[1]);
      if (code === 243) {
        return "npm couldn't access its cache directory (~/.npm). This usually happens when npm was previously run with sudo.\n\nTo fix, open a terminal and run:\nsudo chown -R $(whoami) ~/.npm";
      }
      if (code === 128) {
        return "Git authentication failed. Make sure you're signed into GitHub.";
      }
      if (code === 69) {
        return 'Xcode Command Line Tools license has not been accepted. Open Terminal and run:\nsudo xcodebuild -license accept\n\nThen try creating the project again.';
      }
    }
    // Strip the "Error: " prefix that comes from Error.toString()
    return msg.replace(/^Error:\s*/, '');
  };

  /** Run npm install via PTY, with a pre-check for permissions */
  const runNpmInstall = async (projectPath: string) => {
    // Pre-check: verify npm cache is writable
    const cacheStatus = await checkNpmCachePermissions();
    if (cacheStatus === 'not_writable') {
      throw new Error(
        "npm can't write to its cache directory (~/.npm). This usually happens when npm was previously run with sudo.\n\nTo fix, open a terminal and run:\nsudo chown -R $(whoami) ~/.npm"
      );
    }

    const installId = await invoke<number>('spawn_pty', {
      options: {
        cwd: projectPath,
        command: 'npm',
        args: ['install'],
        rows: 10,
        cols: 80,
      },
      windowLabel: getWindowLabel(),
    });

    await waitForPtyExit(installId);
  };

  // ---- Handlers ----

  /** Retry just the npm install step (project already cloned + initialized) */
  const retryInstall = async () => {
    if (!createdProjectPath) return;

    setError(null);
    setCurrentStep('install');

    try {
      await runNpmInstall(createdProjectPath);

      setCurrentStep('done');
      await new Promise((r) => setTimeout(r, 800));
      onComplete(createdProjectPath);
    } catch (err) {
      trackError('project_install_retry', err, 'Dashboard');
      setError(getFriendlyError(err));
    }
  };

  const handleCreate = async () => {
    if (!selectedTemplate) {
      setError('Please select a template');
      return;
    }

    if (!projectName.trim()) {
      setError('Please enter a project name');
      return;
    }

    const safeName = projectName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!safeName) {
      setError('Invalid project name');
      return;
    }

    // Check for duplicate project names
    try {
      const existingProjects = await invoke<{ name: string; path: string }[]>('list_projects');
      const duplicate = existingProjects.find(
        (p) => p.name.toLowerCase() === safeName.toLowerCase()
      );
      if (duplicate) {
        setError(`A project named "${safeName}" already exists`);
        return;
      }
    } catch {
      // If we can't check, proceed anyway
    }

    setIsCreating(true);
    setError(null);
    setCurrentStep('clone');

    try {
      // Ensure ShipStudio directory exists
      const shipstudioDir = await invoke<string>('ensure_shipstudio_dir');
      const projectPath = `${shipstudioDir}/${safeName}`;

      if (selectedTemplate.id === 'blank') {
        // Blank project: just create the directory
        await invoke('create_blank_project', { projectPath });
        setCreatedProjectPath(projectPath);
        setCurrentStep('done');
      } else {
        // Clone template
        const cloneId = await invoke<number>('spawn_pty', {
          options: {
            cwd: shipstudioDir,
            command: 'git',
            args: ['clone', selectedTemplate.repo, safeName],
            rows: 10,
            cols: 80,
          },
          windowLabel: getWindowLabel(),
        });

        await waitForPtyExit(cloneId);

        // Remove .git folder so project starts fresh (not connected to template repo)
        setCurrentStep('init');
        await invoke('remove_git_history', { projectPath });

        // Ensure .shipstudio/ is gitignored to prevent phantom changes
        await invoke('ensure_gitignore_has_shipstudio', { projectPath: projectPath });

        // Pre-install Vercel plugin (fire-and-forget, don't block creation)
        installPlugin(projectPath, VERCEL_PLUGIN_REPO).catch(() => {});

        // Install dependencies (skip for templates with no package.json)
        setCreatedProjectPath(projectPath);
        if (selectedTemplate.skipInstall) {
          setCurrentStep('done');
        } else {
          setCurrentStep('install');
          await runNpmInstall(projectPath);
          setCurrentStep('done');
        }
      }

      // Small delay before opening
      await new Promise((r) => setTimeout(r, 800));
      onComplete(projectPath);
    } catch (err) {
      trackError('project_create', err, 'Dashboard');
      setError(getFriendlyError(err));
    }
  };

  const handleCreateFromZip = async () => {
    if (!zipFile && !zipPath) {
      setError('Please select a zip template');
      return;
    }

    if (!projectName.trim()) {
      setError('Please enter a project name');
      return;
    }

    const safeName = projectName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!safeName) {
      setError('Invalid project name');
      return;
    }

    // Check for duplicate project names
    try {
      const existingProjects = await invoke<{ name: string; path: string }[]>('list_projects');
      const duplicate = existingProjects.find(
        (p) => p.name.toLowerCase() === safeName.toLowerCase()
      );
      if (duplicate) {
        setError(`A project named "${safeName}" already exists`);
        return;
      }
    } catch {
      // If we can't check, proceed anyway
    }

    setIsCreating(true);
    setError(null);
    setCurrentStep('clone');

    try {
      // Extract template - pass either zipData (from browser) or zipPath (from Tauri drop)
      let zipData: number[] | null = null;
      if (zipFile) {
        const arrayBuffer = await zipFile.arrayBuffer();
        zipData = Array.from(new Uint8Array(arrayBuffer));
      }

      const projectPath = await invoke<string>('extract_template_zip', {
        projectName: safeName,
        zipData: zipData,
        zipPath: zipPath,
      });

      // Remove .git folder if present
      setCurrentStep('init');
      await invoke('remove_git_history', { projectPath });

      // Ensure .shipstudio/ is gitignored
      await invoke('ensure_gitignore_has_shipstudio', { projectPath });

      // Install dependencies (skip if no package.json, e.g. HTML-only zip)
      setCreatedProjectPath(projectPath);
      let hasPackageJson = false;
      try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        await readTextFile(`${projectPath}/package.json`);
        hasPackageJson = true;
      } catch {
        // No package.json - skip install
      }

      if (hasPackageJson) {
        setCurrentStep('install');
        await runNpmInstall(projectPath);
      }

      setCurrentStep('done');

      // Small delay before opening
      await new Promise((r) => setTimeout(r, 800));
      onComplete(projectPath);
    } catch (err) {
      trackError('project_create_zip', err, 'Dashboard');
      setError(getFriendlyError(err));
    }
  };

  const getStepStatus = (stepId: Step): 'pending' | 'active' | 'done' => {
    const stepOrder = STEPS.map((s) => s.id);
    const currentIndex = stepOrder.indexOf(currentStep);
    const stepIndex = stepOrder.indexOf(stepId);

    if (stepIndex < currentIndex) return 'done';
    if (stepIndex === currentIndex) return 'active';
    return 'pending';
  };

  const handleTemplateSelect = (template: Template) => {
    setSelectedTemplate(template);
    // Clear all zip state when selecting built-in template
    setZipFile(null);
    setZipPath(null);
    setZipFileName(null);
  };

  const handleContinue = () => {
    if (selectedTemplate || zipFile || zipPath) {
      setFormStep('enter-name');
      setError(null);
    }
  };

  const handleBack = () => {
    setFormStep('select-template');
    setError(null);
  };

  // ---- Drag & drop / file handlers ----

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Need to set dropEffect for the drop to work
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set dragging to false if we're leaving the drop zone entirely
    const rect = dropZoneRef.current?.getBoundingClientRect();
    if (rect) {
      const { clientX, clientY } = e;
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        setIsDragging(false);
      }
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.name.endsWith('.zip')) {
        setZipFile(file);
        setSelectedTemplate(null); // Clear built-in template selection
        setError(null);
      } else {
        setError('Please drop a .zip file');
      }
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.endsWith('.zip')) {
        setZipFile(file);
        setSelectedTemplate(null); // Clear built-in template selection
        setError(null);
      } else {
        setError('Please select a .zip file');
      }
    }
  }, []);

  const handleRemoveZip = useCallback(() => {
    setZipFile(null);
    setZipPath(null);
    setZipFileName(null);
    setSelectedTemplate(getDefaultTemplate()); // Restore default template selection
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const saveDefaultTemplate = useCallback((templateId: string) => {
    localStorage.setItem(DEFAULT_TEMPLATE_KEY, templateId);
  }, []);

  const defaultTemplateId = getDefaultTemplate().id;

  // ---- Public API ----

  return {
    // State
    formStep,
    selectedTemplate,
    projectName,
    setProjectName,
    isCreating,
    currentStep,
    error,
    createdProjectPath,
    isDragging,

    // Refs
    fileInputRef,
    dropZoneRef,

    // Computed
    hasZipTemplate,
    displayZipName,

    // Handlers
    handleCreate,
    handleCreateFromZip,
    handleTemplateSelect,
    handleContinue,
    handleBack,
    retryInstall,
    getStepStatus,

    // Drag / drop / file handlers
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelect,
    handleRemoveZip,

    // Zip state setters (for community template download flow)
    setZipPath,
    setZipFileName,
    setError,

    // Default template
    saveDefaultTemplate,
    defaultTemplateId,

    // Callbacks passed through
    onCancel,
  };
}
