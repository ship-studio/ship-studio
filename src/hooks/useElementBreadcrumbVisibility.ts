import { useCallback, useEffect, useState } from 'react';

import {
  ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT,
  getElementBreadcrumbEnabled,
  setElementBreadcrumbEnabled,
} from '../lib/settings';

/** Mirrors the persisted element breadcrumb preference into React state. */
export function useElementBreadcrumbVisibility(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void getElementBreadcrumbEnabled().then((value) => {
      if (!cancelled) setEnabled(value);
    });
    const handleChanged = (event: Event) => {
      const value = (event as CustomEvent<boolean>).detail;
      if (typeof value === 'boolean') setEnabled(value);
    };
    window.addEventListener(ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT, handleChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT, handleChanged);
    };
  }, []);

  const update = useCallback((value: boolean) => {
    setEnabled(value);
    void setElementBreadcrumbEnabled(value);
  }, []);

  return [enabled, update];
}
