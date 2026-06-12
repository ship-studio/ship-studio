/**
 * Preview-pane setup gate for Shopify theme projects.
 *
 * Shopify themes render through `shopify theme dev`, which needs the Shopify
 * CLI and a connected store. Rather than dead-ending the user with a blank
 * preview, this gate walks them through both steps — leaning on the embedded
 * agent for the CLI install (same pattern as DeviceMirror's mobile toolchain
 * setup). Once everything is in place it calls back so the parent can swap in
 * the real Preview and boot the dev server.
 *
 * @module components/ShopifySetup
 */

import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  checkShopifyCliStatus,
  getShopifyStore,
  setShopifyStore,
  normalizeStoreDomain,
  SHOPIFY_CLI_SETUP_PROMPT,
  SHOPIFY_PARTNERS_URL,
} from '../lib/shopify';
import { useOptionalToast } from '../contexts/ToastContext';
import { Button } from './primitives/Button';
import { ResetIcon } from './icons';
import { logger } from '../lib/logger';

type GateStep = 'checking' | 'cli-missing' | 'store-missing';

interface ShopifySetupProps {
  projectPath: string;
  /** Paste a prompt into the active agent terminal (user still presses Enter). */
  onSendToAgent?: (prompt: string) => void;
  /** CLI + store were already in place — show the preview, server is running. */
  onReady: () => void;
  /** The user just connected a store — show the preview AND start the server. */
  onConnected: () => void;
}

export function ShopifySetup({
  projectPath,
  onSendToAgent,
  onReady,
  onConnected,
}: ShopifySetupProps) {
  const { showToast } = useOptionalToast();
  const [step, setStep] = useState<GateStep>('checking');
  const [storeInput, setStoreInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Bump to re-run the checks ("Try again" after the agent installs the CLI).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStep('checking');
    void (async () => {
      try {
        const cli = await checkShopifyCliStatus();
        if (cancelled) return;
        if (!cli.installed) {
          setStep('cli-missing');
          return;
        }
        const store = await getShopifyStore(projectPath);
        if (cancelled) return;
        if (store) {
          onReady();
        } else {
          setStep('store-missing');
        }
      } catch (err) {
        logger.error('[ShopifySetup] Status check failed', { error: String(err) });
        if (!cancelled) setStep('cli-missing');
      }
    })();
    return () => {
      cancelled = true;
    };
    // onReady is intentionally not a dep — parents pass inline closures and the
    // check should re-run only on project change / explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, attempt]);

  const handleAgentSetup = () => {
    onSendToAgent?.(SHOPIFY_CLI_SETUP_PROMPT);
    showToast('Prompt pasted — press Enter in the terminal to run it', 'success');
  };

  const handleConnect = async () => {
    const store = normalizeStoreDomain(storeInput);
    if (!store) {
      setInputError('Enter your store domain, like my-store.myshopify.com');
      return;
    }
    setInputError(null);
    setIsSaving(true);
    try {
      await setShopifyStore(projectPath, store);
      showToast(`Connected to ${store}`, 'success');
      onConnected();
    } catch (err) {
      logger.error('[ShopifySetup] Failed to save store', { error: String(err) });
      setInputError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  if (step === 'checking') {
    return (
      <div className="preview-install-prompt shopify-setup">
        <p className="hint">Checking Shopify setup…</p>
      </div>
    );
  }

  if (step === 'cli-missing') {
    return (
      <div className="preview-install-prompt shopify-setup">
        <h3>Set up the Shopify CLI</h3>
        <p className="hint">
          Previewing Shopify themes needs the Shopify CLI, which renders your theme with real store
          data and hot reload.
        </p>
        {onSendToAgent && <p className="hint">Let the agent install and configure it for you.</p>}
        {onSendToAgent && (
          <Button variant="primary" size="sm" onClick={handleAgentSetup}>
            Set up with AI
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={() => setAttempt((a) => a + 1)}>
          <ResetIcon size={14} /> Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="preview-install-prompt shopify-setup">
      <h3>Connect your Shopify store</h3>
      <p className="hint">
        The preview renders your theme against a real store. Enter your store&apos;s domain — the
        first run opens your browser to log in to Shopify.
      </p>
      <div className="shopify-setup-form">
        <input
          type="text"
          className="shopify-setup-input"
          placeholder="my-store.myshopify.com"
          value={storeInput}
          onChange={(e) => setStoreInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleConnect();
          }}
          disabled={isSaving}
          autoFocus
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleConnect()}
          disabled={isSaving}
        >
          {isSaving ? 'Connecting…' : 'Connect store'}
        </Button>
      </div>
      {inputError && <p className="shopify-setup-error">{inputError}</p>}
      <p className="hint">
        Don&apos;t have a store?{' '}
        <button
          type="button"
          className="shopify-setup-link"
          onClick={() => void openUrl(SHOPIFY_PARTNERS_URL)}
        >
          Create a free development store
        </button>
      </p>
    </div>
  );
}
