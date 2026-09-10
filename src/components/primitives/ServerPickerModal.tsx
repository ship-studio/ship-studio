import { useCallback, useEffect, useState } from 'react';
import { Button } from './Button';
import { ModalFrame } from './ModalFrame';
import { Spinner } from './Spinner';
import { SERVER_PICKER_EVENT, type ServerPickerRequest } from '../../lib/serverPicker';

interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export function ServerPickerModal() {
  const [request, setRequest] = useState<ServerPickerRequest | null>(null);
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
      const response = await fetch(`/api/browse${suffix}`, { credentials: 'same-origin' });
      const body = (await response.json()) as {
        ok: boolean;
        data?: BrowseResult;
        error?: { reason?: string; message?: string };
      };
      if (!body.ok || !body.data) {
        throw new Error(body.error?.reason ?? body.error?.message ?? 'Unable to browse folder');
      }
      setResult(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const next = (event as CustomEvent<ServerPickerRequest>).detail;
      setRequest((current) => {
        current?.resolve(null);
        return next;
      });
      setResult(null);
      void load();
    };
    window.addEventListener(SERVER_PICKER_EVENT, onRequest);
    return () => window.removeEventListener(SERVER_PICKER_EVENT, onRequest);
  }, [load]);

  const finish = (path: string | null) => {
    request?.resolve(path);
    setRequest(null);
    setResult(null);
  };

  return (
    <ModalFrame
      isOpen={request !== null}
      onClose={() => finish(null)}
      title={request?.title}
      className="server-picker-modal"
    >
      <div className="server-picker-path" title={result?.path}>
        {result?.path ?? 'Loading…'}
      </div>
      <div className="server-picker-list" role="list" aria-label="Server folders">
        {loading ? (
          <Spinner size="md" />
        ) : error ? (
          <p className="server-picker-error">{error}</p>
        ) : (
          result?.entries
            .filter((entry) => entry.isDirectory)
            .map((entry) => (
              <button
                type="button"
                className="server-picker-entry"
                key={entry.path}
                onClick={() => void load(entry.path)}
              >
                {entry.name}
              </button>
            ))
        )}
      </div>
      <div className="server-picker-actions">
        <Button
          variant="secondary"
          onClick={() => result?.parent && void load(result.parent)}
          disabled={!result?.parent || loading}
        >
          Up
        </Button>
        <span className="server-picker-actions-spacer" />
        <Button variant="secondary" onClick={() => finish(null)}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => finish(result?.path ?? null)} disabled={!result}>
          Select folder
        </Button>
      </div>
    </ModalFrame>
  );
}
