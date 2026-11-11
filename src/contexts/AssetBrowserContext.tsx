import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useModal } from './ModalContext';
import type { Asset } from '../lib/assets';
import { ImageIcon } from '@/components/icons';
import { useCommands } from '../commands/useCommands';

export type AssetBrowserPresentation = 'modal' | 'panel';
export const ASSET_BROWSER_PRESENTATION_KEY = 'shipstudio.assets.browserPresentation';

export interface AssetPickRequest {
  id: number;
  projectPath: string;
  title: string;
  onPick: (asset: Asset, assetsRoot: string) => void | Promise<void>;
}

interface AssetBrowserContextValue {
  presentation: AssetBrowserPresentation;
  panelOpen: boolean;
  modalOpen: boolean;
  pickRequest: AssetPickRequest | null;
  openManager: (forceModal?: boolean) => void;
  toggleManager: (forceModal?: boolean) => void;
  openPicker: (request: Omit<AssetPickRequest, 'id'>) => number;
  closeBrowser: () => void;
  closePanel: () => void;
  cancelPicker: (id?: number) => void;
  pickAsset: (id: number, asset: Asset, assetsRoot: string) => Promise<void>;
  switchPresentation: (next: AssetBrowserPresentation) => void;
}

const AssetBrowserContext = createContext<AssetBrowserContextValue | null>(null);

function readPresentation(): AssetBrowserPresentation {
  try {
    return localStorage.getItem(ASSET_BROWSER_PRESENTATION_KEY) === 'panel' ? 'panel' : 'modal';
  } catch {
    return 'modal';
  }
}

export function AssetBrowserProvider({
  projectPath,
  focusMode = false,
  children,
}: {
  projectPath: string;
  focusMode?: boolean;
  children: ReactNode;
}) {
  const modal = useModal('assetsPanel');
  const [presentation, setPresentation] = useState(readPresentation);
  const [panelState, setPanelState] = useState({ projectPath, open: false });
  const panelOpen = panelState.projectPath === projectPath && panelState.open;
  const setPanelOpen = useCallback(
    (open: boolean) => setPanelState({ projectPath, open }),
    [projectPath]
  );
  const [pickState, setPickState] = useState<{
    projectPath: string;
    request: AssetPickRequest | null;
  }>({ projectPath, request: null });
  const pickRequest = pickState.projectPath === projectPath ? pickState.request : null;
  const pickRef = useRef<AssetPickRequest | null>(null);
  const nextPickId = useRef(0);
  const projectRef = useRef(projectPath);

  const clearPick = useCallback(() => {
    pickRef.current = null;
    setPickState({ projectPath, request: null });
  }, [projectPath]);

  const closeBrowser = useCallback(() => {
    clearPick();
    setPanelOpen(false);
    modal.close();
  }, [clearPick, modal, setPanelOpen]);

  const switchPresentation = useCallback(
    (next: AssetBrowserPresentation) => {
      setPresentation(next);
      try {
        localStorage.setItem(ASSET_BROWSER_PRESENTATION_KEY, next);
      } catch {
        // Browser mode remains usable for this session if storage is unavailable.
      }
      if (next === 'panel' && !focusMode) {
        modal.close();
        setPanelOpen(true);
      } else {
        setPanelOpen(false);
        modal.open();
      }
    },
    [focusMode, modal, setPanelOpen]
  );

  const openManager = useCallback(
    (forceModal = false) => {
      clearPick();
      setPanelOpen(false);
      if (presentation === 'panel' && !forceModal && !focusMode) {
        modal.close();
        setPanelOpen(true);
      } else {
        setPanelOpen(false);
        modal.open();
      }
    },
    [clearPick, focusMode, modal, presentation, setPanelOpen]
  );

  const toggleManager = useCallback(
    (forceModal = false) => {
      if (panelOpen || modal.isOpen) {
        closeBrowser();
        return;
      }
      openManager(forceModal);
    },
    [closeBrowser, modal.isOpen, openManager, panelOpen]
  );

  useCommands(
    () => [
      {
        id: 'assets.open',
        title: 'Open Assets',
        icon: <ImageIcon size={14} />,
        category: 'action',
        when: 'project',
        keywords: ['images', 'media', 'files', 'library'],
        run: () => openManager(),
      },
    ],
    [openManager]
  );

  const openPicker = useCallback(
    (request: Omit<AssetPickRequest, 'id'>) => {
      const next = { ...request, id: ++nextPickId.current };
      pickRef.current = next;
      setPickState({ projectPath, request: next });
      if (presentation === 'panel' && !focusMode) {
        modal.close();
        setPanelOpen(true);
      } else {
        setPanelOpen(false);
        modal.open();
      }
      return next.id;
    },
    [focusMode, modal, presentation, projectPath, setPanelOpen]
  );

  const cancelPicker = useCallback(
    (id?: number) => {
      if (id != null && pickRef.current?.id !== id) return;
      clearPick();
      setPanelOpen(false);
      modal.close();
    },
    [clearPick, modal, setPanelOpen]
  );

  const pickAsset = useCallback(
    async (id: number, asset: Asset, assetsRoot: string) => {
      const request = pickRef.current;
      if (!request || request.id !== id || request.projectPath !== projectPath) return;
      await request.onPick(asset, assetsRoot);
      if (pickRef.current?.id === id) {
        clearPick();
        setPanelOpen(false);
        modal.close();
      }
    },
    [clearPick, modal, projectPath, setPanelOpen]
  );

  useEffect(() => {
    if (projectRef.current === projectPath) return;
    projectRef.current = projectPath;
    pickRef.current = null;
    modal.close();
  }, [modal, projectPath]);

  const value = useMemo<AssetBrowserContextValue>(
    () => ({
      presentation,
      panelOpen,
      modalOpen: modal.isOpen,
      pickRequest,
      openManager,
      toggleManager,
      openPicker,
      closeBrowser,
      closePanel: closeBrowser,
      cancelPicker,
      pickAsset,
      switchPresentation,
    }),
    [
      presentation,
      panelOpen,
      modal.isOpen,
      pickRequest,
      openManager,
      toggleManager,
      openPicker,
      closeBrowser,
      cancelPicker,
      pickAsset,
      switchPresentation,
    ]
  );

  return <AssetBrowserContext.Provider value={value}>{children}</AssetBrowserContext.Provider>;
}

export function useAssetBrowser(): AssetBrowserContextValue {
  const context = useContext(AssetBrowserContext);
  if (!context) throw new Error('useAssetBrowser must be used inside AssetBrowserProvider');
  return context;
}

export function useOptionalAssetBrowser(): AssetBrowserContextValue | null {
  return useContext(AssetBrowserContext);
}
