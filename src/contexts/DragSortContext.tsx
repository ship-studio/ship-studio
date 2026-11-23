import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { DragSortManager, type DragSortManagerOptions } from '../lib/drag-sort/manager';
import { DragSortContext, type DragSortContextValue } from './dragSortContextValue';

export interface DragSortScopeProps extends DragSortManagerOptions {
  children: ReactNode;
  /** Optional accessible name for the sortable region. */
  label?: string;
  /** Stable IDs can be supplied for documentation and duplicate checking. */
  items?: readonly (string | number)[];
  /** Add a presentation class to the projected insertion gap. */
  placeholderClassName?: string;
}

export function DragSortScope({
  children,
  axis = 'vertical',
  collision = 'midpoint',
  allowCrossGroup = false,
  canMove,
  onMove,
  announcements,
  reducedMotion,
  placementForTarget,
  projectOrder,
  hasProjectedMove,
  isPartOfActiveMove,
  insideHoldDelayMs,
  insideHoldFlashDurationMs,
  label = 'Sortable list',
  items,
  placeholderClassName,
}: DragSortScopeProps) {
  const [manager] = useState(
    () =>
      new DragSortManager({
        axis,
        collision,
        allowCrossGroup,
        canMove,
        onMove,
        announcements,
        reducedMotion,
        placementForTarget,
        projectOrder,
        hasProjectedMove,
        isPartOfActiveMove,
        insideHoldDelayMs,
        insideHoldFlashDurationMs,
      })
  );
  const instructionsId = `drag-sort-instructions-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    manager.setOptions({
      axis,
      collision,
      allowCrossGroup,
      canMove,
      onMove,
      announcements,
      reducedMotion,
      placementForTarget,
      projectOrder,
      hasProjectedMove,
      isPartOfActiveMove,
      insideHoldDelayMs,
      insideHoldFlashDurationMs,
    });
  }, [
    announcements,
    axis,
    allowCrossGroup,
    canMove,
    collision,
    hasProjectedMove,
    manager,
    isPartOfActiveMove,
    onMove,
    placementForTarget,
    projectOrder,
    reducedMotion,
    insideHoldDelayMs,
    insideHoldFlashDurationMs,
  ]);

  useEffect(() => {
    if (!items) return;
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${typeof item}:${String(item)}`;
      if (seen.has(key)) manager.reportError(`Drag-sort IDs must be unique: ${String(item)}`);
      seen.add(key);
    }
  }, [items, manager]);

  useEffect(() => () => manager.destroy(), [manager]);

  const value = useMemo(
    () => ({ manager, instructionsId, label }),
    [instructionsId, label, manager]
  );
  return (
    <DragSortContext.Provider value={value}>
      {children}
      <DragSortFeedback
        manager={manager}
        instructionsId={instructionsId}
        label={label}
        placeholderClassName={placeholderClassName}
      />
    </DragSortContext.Provider>
  );
}

function DragSortFeedback({
  manager,
  instructionsId,
  label,
  placeholderClassName,
}: Pick<DragSortContextValue, 'manager' | 'instructionsId' | 'label'> & {
  placeholderClassName?: string;
}) {
  const snapshot = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot
  );
  const activeRegistration =
    snapshot.activeId === null ? undefined : manager.getItem(snapshot.activeId);
  const overlayRect = snapshot.overlayRect;
  const overlayStyle: CSSProperties | undefined = overlayRect
    ? ({
        '--drag-sort-overlay-width': `${overlayRect.width}px`,
        '--drag-sort-overlay-height': `${overlayRect.height}px`,
        '--drag-sort-overlay-x': `${overlayRect.left}px`,
        '--drag-sort-overlay-y': `${overlayRect.top}px`,
      } as CSSProperties)
    : undefined;
  const hasOverlay =
    activeRegistration?.overlay !== undefined &&
    activeRegistration?.overlay !== null &&
    activeRegistration?.overlay !== false;
  const overlayActive = Boolean(hasOverlay && overlayRect && snapshot.activeId !== null);
  const targetRegistration =
    snapshot.targetId === null ? undefined : manager.getItem(snapshot.targetId);
  const crossesGroup = Boolean(
    activeRegistration &&
    targetRegistration &&
    (activeRegistration.group ?? 'default') !== (targetRegistration.group ?? 'default')
  );
  const targetSuppressesPlaceholder = Boolean(
    (targetRegistration?.targetOnly || targetRegistration?.showTargetIndicator) && !crossesGroup
  );
  const placeholderRect =
    overlayActive &&
    snapshot.targetId !== null &&
    snapshot.placement !== null &&
    !(snapshot.placement === 'inside' && snapshot.insideHold === 'ready') &&
    !targetSuppressesPlaceholder &&
    snapshot.invalidReason === null &&
    snapshot.phase !== 'cancelling'
      ? crossesGroup
        ? manager.getCrossGroupPlaceholderRect(
            snapshot.activeId!,
            snapshot.targetId,
            snapshot.placement
          )
        : manager.getProjectedRect(snapshot.activeId!)
      : null;
  const placeholderStyle: CSSProperties | undefined = placeholderRect
    ? ({
        '--drag-sort-placeholder-width': `${placeholderRect.width}px`,
        '--drag-sort-placeholder-height': `${placeholderRect.height}px`,
        '--drag-sort-placeholder-x': `${placeholderRect.left}px`,
        '--drag-sort-placeholder-y': `${placeholderRect.top}px`,
      } as CSSProperties)
    : undefined;
  // Mount the body portal with the scope, then only reveal its presentational
  // child after activation has supplied a concrete rect. This removes a
  // WebKit/Tauri paint race where the in-flow source was suppressed in the
  // same commit that first created the portal. The host remains out of hit
  // testing while idle and carries no interactive controls.
  const overlay = createPortal(
    <div
      className="drag-sort__overlay"
      data-drag-sort-overlay-host="true"
      data-drag-sort-overlay={overlayActive ? 'true' : undefined}
      data-drag-sort-id={overlayActive ? String(snapshot.activeId) : undefined}
      data-drag-sort-phase={overlayActive ? snapshot.phase : undefined}
      style={overlayStyle}
      aria-hidden="true"
      hidden={!overlayActive}
    >
      {overlayActive ? (activeRegistration?.overlay as ReactNode) : null}
    </div>,
    document.body
  );
  const placeholder = placeholderRect
    ? createPortal(
        <div
          className={['drag-sort__placeholder', placeholderClassName].filter(Boolean).join(' ')}
          data-drag-sort-placeholder-gap="true"
          style={placeholderStyle}
          aria-hidden="true"
        />,
        document.body
      )
    : null;
  return (
    <>
      <div id={instructionsId} className="drag-sort__instructions">
        {label}: press Space or Enter to lift, use the arrow keys to move, then press Space or Enter
        to drop. Press Escape to cancel.
      </div>
      <div className="drag-sort__live-region" role="status" aria-live="polite" aria-atomic="true">
        {snapshot.announcement}
      </div>
      {placeholder}
      {overlay}
    </>
  );
}
