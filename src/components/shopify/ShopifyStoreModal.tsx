/**
 * Modal for connecting or changing the Shopify store a theme project
 * previews against. Opened from the command palette ("Change Shopify
 * store…"); the first-run connection happens inline in ShopifySetup.
 *
 * @module components/ShopifyStoreModal
 */

import { useEffect, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useModal } from '../../contexts/ModalContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { getShopifyStore, setShopifyStore, normalizeStoreDomain } from '../../lib/shopify';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface ShopifyStoreModalProps {
  projectPath: string;
  /** Called after a new store is saved so the parent can restart the dev server. */
  onStoreSaved: () => void;
}

export function ShopifyStoreModal({ projectPath, onStoreSaved }: ShopifyStoreModalProps) {
  const { isOpen, close } = useModal('shopifyStore');
  const { showToast } = useOptionalToast();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Prefill with the currently connected store each time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    void getShopifyStore(projectPath)
      .then((store) => {
        if (!cancelled) setInput(store ?? '');
      })
      .catch(() => {
        if (!cancelled) setInput('');
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectPath]);

  const handleSave = async () => {
    const store = normalizeStoreDomain(input);
    if (!store) {
      setError('Enter your store domain, like my-store.myshopify.com');
      return;
    }
    setError(null);
    setIsSaving(true);
    try {
      await setShopifyStore(projectPath, store);
      showToast(`Connected to ${store} — restarting preview`, 'success');
      close();
      onStoreSaved();
    } catch (err) {
      logger.error('[ShopifyStoreModal] Failed to save store', { error: String(err) });
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ModalFrame isOpen={isOpen} onClose={close} title="Shopify store">
      <div className="shopify-store-modal-body">
        <p className="hint">
          The preview renders this theme against a real store via <code>shopify theme dev</code>.
        </p>
        <input
          type="text"
          className="shopify-setup-input"
          placeholder="my-store.myshopify.com"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave();
          }}
          disabled={isSaving}
          autoFocus
        />
        {error && <p className="shopify-setup-error">{error}</p>}
        <div className="shopify-store-modal-actions">
          <Button variant="secondary" size="sm" onClick={close} disabled={isSaving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save & restart preview'}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
