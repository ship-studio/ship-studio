/** Project route inventory, persisted organization, and source page actions. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCommands } from '../../commands/useCommands';
import { useModal } from '../../contexts/ModalContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useInvoke } from '../../hooks/useInvoke';
import {
  createPageFolder,
  emptyProjectPagesState,
  isDynamicPageRoute,
  loadProjectPagesState,
  movePageEntry,
  pageDisplayName,
  projectPagesStorageKey,
  reconcilePageInventory,
  recordPageOpened,
  removePageFolder,
  removePagePreference,
  renamePageFolder,
  renamePagePreference,
  renamePageRoutePreference,
  saveProjectPagesState,
  setPageSortMode,
  siblingEntries,
  swapPageRoutePreferences,
  validateStaticPageRoute,
  type PageEntryRef,
  type PageFolder,
  type PageRouteInfo,
  type PageSortMode,
  type ProjectPagesState,
} from '../../lib/projectPages';
import { getWorkspaceSubpath } from '../../lib/project';
import { Button } from '../primitives/Button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import { IconButton } from '../primitives/IconButton';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { SearchField } from '../primitives/SearchField';
import { TextField } from '../primitives/TextField';
import { TextButton } from '../primitives/TextButton';
import { PagesPanelTree, type FolderPanelAction, type PagePanelAction } from './PagesPanelTree';
import { DockablePanelHeader } from '../workspace/DockablePanelHeader';
import {
  CheckIcon,
  FileTextIcon,
  FolderPlusIcon,
  HomeIcon,
  PlusIcon,
  SortVerticalDownIcon,
} from '@/components/icons';
import '../../styles/features/pages-panel.css';

type PageMutation =
  | { kind: 'create'; route: string }
  | { kind: 'duplicate'; route: string; newRoute: string }
  | { kind: 'move'; route: string; newRoute: string }
  | { kind: 'delete'; route: string }
  | { kind: 'homepage'; route: string };

type PagePanelDialog =
  | { kind: 'create-page'; route: string; displayName: string; formError: string | null }
  | { kind: 'duplicate-page'; page: PageRouteInfo; newRoute: string; formError: string | null }
  | { kind: 'create-folder'; name: string; parentFolderId: string | null; formError: string | null }
  | { kind: 'rename-page'; page: PageRouteInfo; name: string }
  | { kind: 'settings'; page: PageRouteInfo; route: string; name: string; formError: string | null }
  | { kind: 'rename-folder'; folder: PageFolder; name: string }
  | { kind: 'delete-page'; page: PageRouteInfo }
  | { kind: 'delete-folder'; folder: PageFolder };

interface ScopedPageState {
  key: string;
  state: ProjectPagesState;
}

export interface PagesPanelProps {
  projectPath: string;
  currentRoute?: string;
  selectedTemplateRoute?: string | null;
  projectType?: string | null;
  /** Optional resolved workspace scope from the caller (repo-relative subpath). */
  workspaceKey?: string;
  onOpenPage: (route: string) => void;
  /** Open a source file in the workspace Code browser. */
  onOpenSourceFile: (filePath: string) => void;
  /** Open a duplicated route after the running preview serves it successfully. */
  onOpenDuplicatedPage: (route: string) => Promise<'opened' | 'not-ready' | 'cancelled'>;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}

const SORT_OPTIONS: { value: PageSortMode; label: string }[] = [
  { value: 'manual', label: 'Manual order' },
  { value: 'az', label: 'A to Z' },
  { value: 'za', label: 'Z to A' },
  { value: 'recent', label: 'Recently used' },
];

export function PagesPanel({
  projectPath,
  currentRoute,
  selectedTemplateRoute = null,
  projectType,
  workspaceKey,
  onOpenPage,
  onOpenSourceFile,
  onOpenDuplicatedPage,
  pinned,
  onTogglePin,
  onClose,
}: PagesPanelProps) {
  const { showToast } = useOptionalToast();
  const editorModal = useModal('pagesPanelEditor');
  const [dialog, setDialog] = useState<PagePanelDialog | null>(null);
  const [query, setQuery] = useState('');
  const [workspaceResolvedPath, setWorkspaceResolvedPath] = useState<string | null>(null);
  const [scopedState, setScopedState] = useState<ScopedPageState | null>(null);
  const lastVisitedRef = useRef<string | null>(null);
  const fetchWorkspaceIdentity = useCallback(
    async (path: string) => ({ subpath: await getWorkspaceSubpath(path) }),
    []
  );
  const workspaceRequest = useAsyncState(fetchWorkspaceIdentity);
  const workspaceRequestId = useRef(0);
  const pageInventory = useInvoke<PageRouteInfo[]>('list_pages');
  const mutation = useInvoke<PageRouteInfo[]>('mutate_project_page');
  const {
    execute: executeWorkspace,
    error: workspaceError,
    data: workspaceData,
  } = workspaceRequest;
  const {
    data: inventoryData,
    execute: executePageInventory,
    error: inventoryError,
  } = pageInventory;
  const { setData: setInventoryData } = pageInventory;
  const {
    execute: executeMutation,
    reset: resetMutation,
    error: mutationError,
    isLoading: mutationLoading,
  } = mutation;
  const { open: openEditor, close: closeEditor, isOpen: editorIsOpen } = editorModal;
  const closeEditorRef = useRef(closeEditor);

  const resolveWorkspaceIdentity = useCallback(
    async (path: string) => {
      const requestId = ++workspaceRequestId.current;
      const result = await executeWorkspace(path);
      if (result && requestId === workspaceRequestId.current) {
        setWorkspaceResolvedPath(path);
      }
    },
    [executeWorkspace]
  );

  useEffect(() => {
    if (workspaceKey !== undefined) {
      workspaceRequestId.current += 1;
      return;
    }
    let active = true;
    queueMicrotask(() => {
      if (active) void resolveWorkspaceIdentity(projectPath);
    });
    return () => {
      active = false;
      workspaceRequestId.current += 1;
    };
  }, [projectPath, resolveWorkspaceIdentity, workspaceKey]);

  const storageKey = useMemo(() => {
    if (workspaceKey !== undefined) return projectPagesStorageKey(projectPath, workspaceKey);
    if (workspaceResolvedPath !== projectPath) return null;
    return workspaceData ? projectPagesStorageKey(projectPath, workspaceData.subpath) : null;
  }, [projectPath, workspaceData, workspaceKey, workspaceResolvedPath]);

  const updatePreferences = useCallback(
    (update: (state: ProjectPagesState) => ProjectPagesState) => {
      if (!storageKey) return;
      setScopedState((current) => {
        const currentState =
          current?.key === storageKey ? current.state : loadProjectPagesState(storageKey);
        const stateWithCurrentInventory =
          inventoryData === null
            ? currentState
            : reconcilePageInventory(currentState, inventoryData);
        const nextState = update(stateWithCurrentInventory);
        saveProjectPagesState(storageKey, nextState);
        return { key: storageKey, state: nextState };
      });
    },
    [inventoryData, storageKey]
  );

  useEffect(() => {
    if (!storageKey) return;
    let active = true;
    queueMicrotask(() => {
      if (active) setScopedState({ key: storageKey, state: loadProjectPagesState(storageKey) });
    });
    return () => {
      active = false;
    };
  }, [storageKey]);

  useEffect(() => {
    void executePageInventory({ projectPath });
  }, [executePageInventory, projectPath]);

  const inventoryReady = inventoryData !== null;
  const pages = useMemo(() => inventoryData ?? [], [inventoryData]);
  const emptyState = useMemo(() => emptyProjectPagesState(), []);
  const scopedStateReady = !!storageKey && scopedState?.key === storageKey;
  const storedState = scopedStateReady ? scopedState.state : emptyState;
  const state = inventoryReady ? reconcilePageInventory(storedState, pages) : storedState;
  const sourceMutationEnabled = projectType === 'astro';

  useEffect(() => {
    if (!storageKey || !inventoryReady || !scopedStateReady || !scopedState) return;
    saveProjectPagesState(storageKey, reconcilePageInventory(scopedState.state, pages));
  }, [inventoryReady, pages, scopedState, scopedStateReady, storageKey]);

  useEffect(() => {
    if (!storageKey || !currentRoute || !pages.some((page) => page.route === currentRoute)) {
      lastVisitedRef.current = null;
      return;
    }
    const visitToken = `${storageKey}:${currentRoute}`;
    if (lastVisitedRef.current === visitToken) return;
    lastVisitedRef.current = visitToken;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      updatePreferences((current) =>
        recordPageOpened(reconcilePageInventory(current, pages), currentRoute)
      );
    });
    return () => {
      active = false;
    };
  }, [currentRoute, pages, storageKey, updatePreferences]);

  useEffect(() => {
    closeEditorRef.current = closeEditor;
  }, [closeEditor]);

  useEffect(() => () => closeEditorRef.current(), []);

  const closeDialog = useCallback(() => {
    setDialog(null);
    resetMutation();
    closeEditor();
  }, [closeEditor, resetMutation]);

  const openSourceFile = useCallback(
    (filePath: string) => {
      closeDialog();
      onOpenSourceFile(filePath);
    },
    [closeDialog, onOpenSourceFile]
  );

  const openDialog = useCallback(
    (next: PagePanelDialog) => {
      resetMutation();
      setDialog(next);
      openEditor();
    },
    [openEditor, resetMutation]
  );

  const showError = useCallback(
    (message: string) => {
      showToast(message, 'error');
    },
    [showToast]
  );

  const applyMutation = useCallback(
    async (nextMutation: PageMutation): Promise<boolean> => {
      if (!sourceMutationEnabled) {
        showError('Source page actions are currently available for Astro projects.');
        return false;
      }
      if ('route' in nextMutation && isDynamicPageRoute(nextMutation.route)) {
        showError('Dynamic route patterns cannot be changed from this panel.');
        return false;
      }
      const result = await executeMutation({ projectPath, mutation: nextMutation });
      if (!result) return false;
      setInventoryData(result);
      updatePreferences((current) => {
        let next = current;
        if (nextMutation.kind === 'move') {
          next = renamePageRoutePreference(next, nextMutation.route, nextMutation.newRoute);
        } else if (nextMutation.kind === 'homepage') {
          next = swapPageRoutePreferences(next, '/', nextMutation.route);
        } else if (nextMutation.kind === 'delete') {
          next = removePagePreference(next, nextMutation.route);
        }
        return reconcilePageInventory(next, result);
      });
      return true;
    },
    [
      executeMutation,
      projectPath,
      setInventoryData,
      showError,
      sourceMutationEnabled,
      updatePreferences,
    ]
  );

  const openPage = useCallback(
    (route: string) => {
      if (!isDynamicPageRoute(route)) {
        updatePreferences((current) => recordPageOpened(current, route));
      }
      onOpenPage(route);
    },
    [onOpenPage, updatePreferences]
  );

  const openPageAction = useCallback(
    (page: PageRouteInfo, action: PagePanelAction) => {
      if (action === 'rename') {
        openDialog({
          kind: 'rename-page',
          page,
          name: pageDisplayName(page.route, state.pages[page.route]),
        });
      } else if (action === 'settings') {
        openDialog({
          kind: 'settings',
          page,
          route: page.route,
          name: pageDisplayName(page.route, state.pages[page.route]),
          formError: null,
        });
      } else if (action === 'duplicate') {
        openDialog({ kind: 'duplicate-page', page, newRoute: '', formError: null });
      } else if (action === 'delete') {
        openDialog({ kind: 'delete-page', page });
      } else if (action === 'homepage') {
        openDialog({
          kind: 'settings',
          page,
          route: page.route,
          name: pageDisplayName(page.route, state.pages[page.route]),
          formError: null,
        });
      }
    },
    [openDialog, state.pages]
  );

  const openFolderAction = useCallback(
    (folder: PageFolder, action: FolderPanelAction) => {
      if (action === 'rename') openDialog({ kind: 'rename-folder', folder, name: folder.name });
      else if (action === 'delete') openDialog({ kind: 'delete-folder', folder });
    },
    [openDialog]
  );

  const moveEntry = useCallback(
    (entry: PageEntryRef, parentFolderId: string | null, index: number) => {
      updatePreferences((current) => movePageEntry(current, entry, parentFolderId, index));
    },
    [updatePreferences]
  );

  const handlePanelClose = useCallback(() => {
    closeDialog();
    onClose();
  }, [closeDialog, onClose]);

  useCommands(
    () => [
      ...(sourceMutationEnabled && storageKey
        ? [
            {
              id: 'pages.create',
              title: 'Create page…',
              icon: <FileTextIcon size={14} />,
              category: 'project' as const,
              when: 'project' as const,
              keywords: ['new page', 'route', 'url'],
              run: () =>
                openDialog({ kind: 'create-page', route: '', displayName: '', formError: null }),
            },
          ]
        : []),
      ...(storageKey
        ? [
            {
              id: 'pages.createFolder',
              title: 'Create Pages folder…',
              icon: <FolderPlusIcon size={14} />,
              category: 'project' as const,
              when: 'project' as const,
              keywords: ['organize', 'new folder'],
              run: () =>
                openDialog({
                  kind: 'create-folder',
                  name: '',
                  parentFolderId: null,
                  formError: null,
                }),
            },
          ]
        : []),
    ],
    [openDialog, sourceMutationEnabled, storageKey]
  );

  const selectSortMode = (sortMode: PageSortMode) => {
    updatePreferences((current) => setPageSortMode(current, sortMode));
  };

  const handleCreatePage = async () => {
    if (dialog?.kind !== 'create-page') return;
    if (!dialog.route.trim()) {
      setDialog({ ...dialog, formError: 'Enter a URL path.' });
      return;
    }
    const validated = validateStaticPageRoute(dialog.route);
    if (validated.error || !validated.route) {
      setDialog({ ...dialog, formError: validated.error ?? 'Enter a URL path.' });
      return;
    }
    if (!sourceMutationEnabled) {
      setDialog({
        ...dialog,
        formError: 'Creating source pages currently requires an Astro project.',
      });
      return;
    }
    const created = await applyMutation({ kind: 'create', route: validated.route });
    if (!created) return;
    if (dialog.displayName.trim()) {
      updatePreferences((current) =>
        renamePagePreference(current, validated.route!, dialog.displayName)
      );
    }
    closeDialog();
    openPage(validated.route);
  };

  const handleDuplicatePage = async () => {
    if (dialog?.kind !== 'duplicate-page') return;
    if (!dialog.newRoute.trim()) {
      setDialog({ ...dialog, formError: 'Enter a URL path.' });
      return;
    }
    const validated = validateStaticPageRoute(dialog.newRoute);
    if (validated.error || !validated.route) {
      setDialog({ ...dialog, formError: validated.error ?? 'Enter a URL path.' });
      return;
    }
    if (!sourceMutationEnabled || isDynamicPageRoute(dialog.page.route)) {
      setDialog({
        ...dialog,
        formError: 'Duplicate is available for static routes in Astro projects.',
      });
      return;
    }
    const created = await applyMutation({
      kind: 'duplicate',
      route: dialog.page.route,
      newRoute: validated.route,
    });
    if (!created) return;
    closeDialog();
    void onOpenDuplicatedPage(validated.route).then((result) => {
      if (result === 'opened') {
        updatePreferences((current) => recordPageOpened(current, validated.route!));
      } else if (result === 'not-ready') {
        showError('The page was duplicated, but the preview did not load it yet.');
      }
    });
  };

  const handleSaveSettings = async () => {
    if (dialog?.kind !== 'settings') return;
    const validated = validateStaticPageRoute(dialog.route);
    const dynamic = isDynamicPageRoute(dialog.page.route);
    if (dialog.route !== dialog.page.route && (validated.error || !validated.route)) {
      setDialog({ ...dialog, formError: validated.error ?? 'Enter a URL path.' });
      return;
    }
    if (dialog.route !== dialog.page.route && (!sourceMutationEnabled || dynamic)) {
      setDialog({ ...dialog, formError: 'URL editing is available for static Astro routes only.' });
      return;
    }
    if (dialog.route !== dialog.page.route) {
      const moved = await applyMutation({
        kind: 'move',
        route: dialog.page.route,
        newRoute: validated.route!,
      });
      if (!moved) return;
    }
    const finalRoute = dialog.route === dialog.page.route ? dialog.page.route : validated.route!;
    updatePreferences((current) => renamePagePreference(current, finalRoute, dialog.name));
    closeDialog();
    if (finalRoute !== dialog.page.route) openPage(finalRoute);
  };

  const handleConfirmDeletePage = async () => {
    if (dialog?.kind !== 'delete-page') return;
    const deleted = await applyMutation({ kind: 'delete', route: dialog.page.route });
    if (deleted) closeDialog();
  };

  const handleConfirmFolderDelete = () => {
    if (dialog?.kind !== 'delete-folder') return;
    updatePreferences((current) => removePageFolder(current, dialog.folder.id));
    closeDialog();
  };

  const handleCreateFolder = () => {
    if (dialog?.kind !== 'create-folder') return;
    const name = dialog.name.trim();
    if (!name || /[\\/]/.test(name)) {
      setDialog({ ...dialog, formError: 'Enter a folder name without / or \\.' });
      return;
    }
    updatePreferences((current) =>
      createPageFolder(current, name, dialog.parentFolderId, makeFolderId())
    );
    closeDialog();
  };

  const handleSaveFolderName = () => {
    if (dialog?.kind !== 'rename-folder') return;
    if (!dialog.name.trim() || /[\\/]/.test(dialog.name)) return;
    updatePreferences((current) => renamePageFolder(current, dialog.folder.id, dialog.name));
    closeDialog();
  };

  const submitCurrentDialog = () => {
    if (dialog?.kind === 'create-page') void handleCreatePage();
    else if (dialog?.kind === 'duplicate-page') void handleDuplicatePage();
    else if (dialog?.kind === 'create-folder') handleCreateFolder();
    else if (dialog?.kind === 'rename-page') {
      updatePreferences((current) => renamePagePreference(current, dialog.page.route, dialog.name));
      closeDialog();
    } else if (dialog?.kind === 'settings') void handleSaveSettings();
    else if (dialog?.kind === 'rename-folder') handleSaveFolderName();
    else if (dialog?.kind === 'delete-page') void handleConfirmDeletePage();
    else if (dialog?.kind === 'delete-folder') handleConfirmFolderDelete();
  };

  const dialogTitle = dialogTitleFor(dialog);
  const dialogError =
    (dialog && 'formError' in dialog ? dialog.formError : null) ?? mutationError?.message ?? null;
  const selectedSort =
    SORT_OPTIONS.find((option) => option.value === state.sortMode)?.label ?? 'Manual order';

  return (
    <section className="pages-panel" data-testid="pages-panel" aria-label="Pages panel">
      <DockablePanelHeader
        title="Pages"
        pinned={pinned}
        onTogglePin={onTogglePin}
        onClose={handlePanelClose}
        pinTitle={{ pinned: 'Unpin Pages panel', unpinned: 'Pin Pages panel' }}
        closeTitle="Close Pages"
      />

      <div className="pages-panel__toolbar">
        <SearchField
          aria-label="Search pages"
          placeholder="Search pages"
          value={query}
          onChange={setQuery}
          className="pages-panel__search"
        />
        <IconButton
          variant="ghost"
          size="compact"
          className="pages-panel__add-page"
          icon={<PlusIcon size={14} />}
          aria-label="Add page"
          onClick={() =>
            openDialog({ kind: 'create-page', route: '', displayName: '', formError: null })
          }
          disabled={!storageKey || !sourceMutationEnabled}
          title={
            sourceMutationEnabled
              ? 'Create a page'
              : 'Creating source pages currently requires Astro'
          }
        />
        <IconButton
          variant="ghost"
          size="compact"
          className="pages-panel__add-folder-trigger"
          icon={<FolderPlusIcon size={14} />}
          aria-label="Add organizational folder"
          title="Add organizational folder"
          onClick={() =>
            openDialog({ kind: 'create-folder', name: '', parentFolderId: null, formError: null })
          }
          disabled={!storageKey}
        />
        <ContextMenu>
          <ContextMenuTrigger asChild openOnClick>
            <IconButton
              variant="ghost"
              size="compact"
              className="pages-panel__sort-trigger"
              icon={<SortVerticalDownIcon size={14} />}
              aria-haspopup="menu"
              aria-label={`Sort pages: ${selectedSort}`}
              title={`Sort: ${selectedSort}`}
            />
          </ContextMenuTrigger>
          <ContextMenuContent aria-label="Sort pages">
            {SORT_OPTIONS.map((option) => (
              <ContextMenuItem
                key={option.value}
                aria-current={state.sortMode === option.value ? 'true' : undefined}
                onSelect={() => selectSortMode(option.value)}
              >
                {state.sortMode === option.value && <CheckIcon size={13} aria-hidden="true" />}
                {option.label}
              </ContextMenuItem>
            ))}
          </ContextMenuContent>
        </ContextMenu>
      </div>

      {projectType !== 'astro' && (
        <div className="pages-panel__notice" role="status">
          Routes are listed here. Creating, duplicating, deleting, moving, or setting a homepage
          currently requires an Astro project.
        </div>
      )}
      {inventoryError && !inventoryReady && (
        <div className="pages-panel__error" role="alert">
          Couldn’t load the page list.{' '}
          <Button
            variant="ghost"
            size="compact"
            onClick={() => void executePageInventory({ projectPath })}
          >
            Retry
          </Button>
        </div>
      )}
      {!storageKey && (
        <div className="pages-panel__loading" role="status">
          {workspaceError ? (
            <>
              <span>Couldn’t resolve this workspace.</span>
              <Button
                variant="ghost"
                size="compact"
                onClick={() => void resolveWorkspaceIdentity(projectPath)}
              >
                Retry
              </Button>
            </>
          ) : (
            <Spinner size="sm" />
          )}
        </div>
      )}
      {storageKey && !inventoryReady && !inventoryError && (
        <div className="pages-panel__loading" role="status">
          <Spinner />
        </div>
      )}
      {inventoryReady && storageKey && (
        <PagesPanelTree
          pages={pages}
          state={state}
          currentRoute={currentRoute}
          selectedTemplateRoute={selectedTemplateRoute}
          query={query}
          sourceMutationEnabled={sourceMutationEnabled}
          onOpenPage={openPage}
          onPageAction={openPageAction}
          onFolderAction={openFolderAction}
          onMoveEntry={moveEntry}
          onDropToRoot={(entry) =>
            moveEntry(entry, null, siblingEntries(state, null, 'manual').length)
          }
        />
      )}

      <ModalFrame
        isOpen={editorIsOpen}
        onClose={closeDialog}
        title={dialogTitle}
        className="pages-panel-dialog"
        dismissable={!mutationLoading}
      >
        {dialog && (
          <div
            className="pages-panel-dialog__body"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
                event.preventDefault();
                submitCurrentDialog();
              }
            }}
          >
            {renderDialogContent({
              dialog,
              setDialog,
              state,
              pages,
              sourceMutationEnabled,
              onOpenSourceFile: openSourceFile,
              onSetHomepage: async (page) => {
                const changed = await applyMutation({ kind: 'homepage', route: page.route });
                if (changed) {
                  closeDialog();
                  openPage('/');
                }
              },
            })}
            {dialogError && (
              <p className="pages-panel-dialog__error" role="alert">
                {dialogError}
              </p>
            )}
            {dialog.kind === 'delete-page' ? (
              <div className="pages-panel-dialog__actions">
                <Button variant="secondary" onClick={closeDialog} disabled={mutationLoading}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={submitCurrentDialog} disabled={mutationLoading}>
                  {mutationLoading ? 'Deleting…' : 'Delete page'}
                </Button>
              </div>
            ) : dialog.kind === 'delete-folder' ? (
              <div className="pages-panel-dialog__actions">
                <Button variant="secondary" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={submitCurrentDialog}>
                  Remove folder
                </Button>
              </div>
            ) : (
              <div
                className={`pages-panel-dialog__actions${
                  dialog.kind === 'settings' ? ' pages-panel-dialog__actions--settings' : ''
                }`}
              >
                <Button variant="secondary" onClick={closeDialog} disabled={mutationLoading}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={submitCurrentDialog} disabled={mutationLoading}>
                  {dialog.kind === 'create-page'
                    ? 'Create page'
                    : dialog.kind === 'duplicate-page'
                      ? 'Duplicate page'
                      : dialog.kind === 'create-folder'
                        ? 'Add folder'
                        : dialog.kind === 'settings'
                          ? 'Save settings'
                          : dialog.kind === 'rename-folder' || dialog.kind === 'rename-page'
                            ? 'Save name'
                            : 'Save'}
                </Button>
              </div>
            )}
          </div>
        )}
      </ModalFrame>
    </section>
  );
}

interface PageRouteFieldProps {
  value: string;
  onChange: (route: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  emptyMeansRoot?: boolean;
  'aria-describedby'?: string;
}

function PageRouteField({
  value,
  onChange,
  emptyMeansRoot = false,
  ...inputProps
}: PageRouteFieldProps) {
  const inputValue = value.startsWith('/') ? value.slice(1) : value;
  return (
    <span className="ss-text-field-shell pages-panel-dialog__route-input">
      <span className="pages-panel-dialog__route-prefix" aria-hidden="true">
        /
      </span>
      <TextField
        {...inputProps}
        value={inputValue}
        onChange={(event) => {
          const entered = event.target.value.trim();
          const path = entered.startsWith('/') ? entered.slice(1) : entered;
          onChange(path ? `/${path}` : emptyMeansRoot ? '/' : '');
        }}
      />
    </span>
  );
}

function renderDialogContent({
  dialog,
  setDialog,
  state,
  pages,
  sourceMutationEnabled,
  onOpenSourceFile,
  onSetHomepage,
}: {
  dialog: PagePanelDialog;
  setDialog: (dialog: PagePanelDialog) => void;
  state: ProjectPagesState;
  pages: readonly PageRouteInfo[];
  sourceMutationEnabled: boolean;
  onOpenSourceFile: (filePath: string) => void;
  onSetHomepage: (page: PageRouteInfo) => Promise<void>;
}) {
  if (dialog.kind === 'create-page') {
    return (
      <>
        <p className="pages-panel-dialog__intro">Create an Astro page from a static URL path.</p>
        <label className="pages-panel-dialog__field">
          <span>URL path</span>
          <PageRouteField
            autoFocus
            placeholder="about"
            value={dialog.route}
            onChange={(route) => setDialog({ ...dialog, route, formError: null })}
          />
        </label>
        <label className="pages-panel-dialog__field">
          <span>
            Display name <small>Optional</small>
          </span>
          <TextField
            placeholder="About"
            value={dialog.displayName}
            onChange={(event) => setDialog({ ...dialog, displayName: event.target.value })}
          />
        </label>
        {!sourceMutationEnabled && (
          <p className="pages-panel-dialog__hint">
            Source pages can currently be created in Astro projects.
          </p>
        )}
      </>
    );
  }
  if (dialog.kind === 'duplicate-page') {
    return (
      <>
        <p className="pages-panel-dialog__intro">
          Copy the source file for <code>{dialog.page.route}</code> to a new static route.
        </p>
        <label className="pages-panel-dialog__field">
          <span>New URL path</span>
          <PageRouteField
            autoFocus
            placeholder="about-copy"
            value={dialog.newRoute}
            onChange={(newRoute) => setDialog({ ...dialog, newRoute, formError: null })}
          />
        </label>
      </>
    );
  }
  if (dialog.kind === 'create-folder') {
    return (
      <>
        <p className="pages-panel-dialog__intro">
          Folders organize this list and do not change project routes or source files.
        </p>
        <label className="pages-panel-dialog__field">
          <span>Folder name</span>
          <TextField
            autoFocus
            placeholder="Marketing"
            value={dialog.name}
            onChange={(event) =>
              setDialog({ ...dialog, name: event.target.value, formError: null })
            }
          />
        </label>
        <label className="pages-panel-dialog__field">
          <span>Parent folder</span>
          <select
            value={dialog.parentFolderId ?? ''}
            onChange={(event) =>
              setDialog({ ...dialog, parentFolderId: event.target.value || null })
            }
          >
            <option value="">Root</option>
            {state.folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </label>
      </>
    );
  }
  if (dialog.kind === 'rename-page') {
    return (
      <>
        <p className="pages-panel-dialog__intro">
          Change the name shown in this panel. The route stays <code>{dialog.page.route}</code>.
        </p>
        <label className="pages-panel-dialog__field">
          <span>Display name</span>
          <TextField
            autoFocus
            value={dialog.name}
            onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
          />
        </label>
      </>
    );
  }
  if (dialog.kind === 'settings') {
    const dynamic = isDynamicPageRoute(dialog.page.route);
    return (
      <>
        <p className="pages-panel-dialog__intro">
          Set a name for the panel and edit the source route when supported.
        </p>
        <label className="pages-panel-dialog__field">
          <span>Display name</span>
          <TextField
            autoFocus
            value={dialog.name}
            onChange={(event) =>
              setDialog({ ...dialog, name: event.target.value, formError: null })
            }
          />
        </label>
        <label className="pages-panel-dialog__field">
          <span>URL path</span>
          <PageRouteField
            value={dialog.route}
            disabled={!sourceMutationEnabled || dynamic}
            emptyMeansRoot
            onChange={(route) => setDialog({ ...dialog, route, formError: null })}
            aria-describedby="pages-settings-route-help"
          />
          <small id="pages-settings-route-help">
            Only static routes in Astro projects can be changed here.
          </small>
        </label>
        <div className="pages-panel-dialog__source">
          <span>Source file</span>
          <TextButton
            className="pages-panel-dialog__source-link"
            title="Open source file in the file browser"
            aria-label={`Open source file in the file browser: ${dialog.page.file_path}`}
            onClick={() => onOpenSourceFile(dialog.page.file_path)}
          >
            {dialog.page.file_path}
          </TextButton>
        </div>
        <div className="pages-panel-dialog__homepage">
          <div>
            <strong>Homepage</strong>
            <span>
              {dialog.page.route === '/'
                ? 'This is the current homepage.'
                : `The current homepage will move to ${dialog.page.route}.`}
            </span>
          </div>
          <Button
            variant="secondary"
            size="compact"
            leftIcon={<HomeIcon size={13} />}
            disabled={!sourceMutationEnabled || dynamic || dialog.page.route === '/'}
            onClick={() => void onSetHomepage(dialog.page)}
          >
            Set homepage
          </Button>
        </div>
      </>
    );
  }
  if (dialog.kind === 'rename-folder') {
    return (
      <label className="pages-panel-dialog__field">
        <span>Folder name</span>
        <TextField
          autoFocus
          value={dialog.name}
          onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
        />
      </label>
    );
  }
  if (dialog.kind === 'delete-page') {
    return (
      <div className="pages-panel-dialog__confirmation">
        <p>
          Delete{' '}
          <strong>{pageDisplayName(dialog.page.route, state.pages[dialog.page.route])}</strong> and
          its source file?
        </p>
        <code>{dialog.page.file_path}</code>
        {!sourceMutationEnabled && (
          <p className="pages-panel-dialog__hint">
            Source deletion currently requires an Astro project.
          </p>
        )}
      </div>
    );
  }
  const folderPages = pages.filter(
    (page) => state.pages[page.route]?.parentFolderId === dialog.folder.id
  );
  return (
    <div className="pages-panel-dialog__confirmation">
      <p>
        Remove the <strong>{dialog.folder.name}</strong> folder from this list?
      </p>
      <p>Its pages and nested folders will move to the folder’s parent.</p>
      {folderPages.length > 0 && (
        <span>
          {folderPages.length} page{folderPages.length === 1 ? '' : 's'} will be kept.
        </span>
      )}
    </div>
  );
}

function dialogTitleFor(dialog: PagePanelDialog | null): string {
  if (!dialog) return 'Pages';
  switch (dialog.kind) {
    case 'create-page':
      return 'Add page';
    case 'duplicate-page':
      return 'Duplicate page';
    case 'create-folder':
      return 'Add folder';
    case 'rename-page':
      return 'Rename page';
    case 'settings':
      return 'Page settings';
    case 'rename-folder':
      return 'Rename folder';
    case 'delete-page':
      return 'Delete page?';
    case 'delete-folder':
      return 'Remove folder?';
  }
}

function makeFolderId(): string {
  return `folder:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
