import { createContext, useContext } from 'react';
import type { DragSortManager } from '../lib/drag-sort/manager';

export interface DragSortContextValue {
  manager: DragSortManager;
  instructionsId: string;
  label: string;
}

// Keep the context identity independent of the scope component's hot reloads.
export const DragSortContext = createContext<DragSortContextValue | null>(null);

export function useDragSortContext(): DragSortContextValue {
  const value = useOptionalDragSortContext();
  if (!value) throw new Error('useDragSortContext must be used inside a DragSortScope');
  return value;
}

export function useOptionalDragSortContext(): DragSortContextValue | null {
  return useContext(DragSortContext);
}
