/**
 * Preview-pane setup gate for HubSpot CMS theme projects.
 *
 * HubSpot themes render through `hs cms theme preview`, which needs the
 * HubSpot CLI installed and signed in to an account. Rather than dead-ending
 * the user with a blank preview, this gate walks them through both steps —
 * leaning on the embedded agent (same pattern as ShopifySetup). Once
 * everything is in place it calls back so the parent can swap in the real
 * Preview and boot the preview server.
 *
 * @module components/HubspotSetup
 */

import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  checkHubspotCliStatus,
  checkHubspotAuthStatus,
  HUBSPOT_CLI_SETUP_PROMPT,
  HUBSPOT_AUTH_SETUP_PROMPT,
  HUBSPOT_DEVELOPERS_URL,
} from '../../lib/hubspot';
import { useOptionalToast } from '../../contexts/ToastContext';
import { Button } from '../primitives/Button';
import { ResetIcon } from '../icons';
import { logger } from '../../lib/logger';

type GateStep = 'checking' | 'cli-missing' | 'auth-missing';

interface HubspotSetupProps {
  projectPath: string;
  /** Paste a prompt into the active agent terminal (user still presses Enter). */
  onSendToAgent?: (prompt: string) => void;
  /** CLI + auth were already in place — show the preview, server is running. */
  onReady: () => void;
  /** Setup just completed after a retry — show the preview AND start the server. */
  onConnected: () => void;
}

export function HubspotSetup({
  projectPath,
  onSendToAgent,
  onReady,
  onConnected,
}: HubspotSetupProps) {
  const { showToast } = useOptionalToast();
  const [step, setStep] = useState<GateStep>('checking');
  // Bump to re-run the checks ("Try again" after the agent fixes setup).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStep('checking');
    void (async () => {
      try {
        const cli = await checkHubspotCliStatus();
        if (cancelled) return;
        if (!cli.installed) {
          setStep('cli-missing');
          return;
        }
        const authed = await checkHubspotAuthStatus();
        if (cancelled) return;
        if (authed) {
          // On the first pass the dev server already started alongside this
          // check; after a retry it was deferred and needs a (re)start.
          if (attempt === 0) {
            onReady();
          } else {
            onConnected();
          }
        } else {
          setStep('auth-missing');
        }
      } catch (err) {
        logger.error('[HubspotSetup] Status check failed', { error: String(err) });
        if (!cancelled) setStep('cli-missing');
      }
    })();
    return () => {
      cancelled = true;
    };
    // onReady/onConnected are intentionally not deps — parents pass inline
    // closures and the check should re-run only on project change / retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, attempt]);

  const handleAgentSetup = (prompt: string) => {
    onSendToAgent?.(prompt);
    showToast('Prompt pasted — press Enter in the terminal to run it', 'success');
  };

  if (step === 'checking') {
    return (
      <div className="preview-install-prompt hubspot-setup">
        <p className="hint">Checking HubSpot setup…</p>
      </div>
    );
  }

  if (step === 'cli-missing') {
    return (
      <div className="preview-install-prompt hubspot-setup">
        <h3>Set up the HubSpot CLI</h3>
        <p className="hint">
          Previewing HubSpot themes needs the HubSpot CLI, which renders your theme against your
          HubSpot account with hot reload.
        </p>
        {onSendToAgent && <p className="hint">Let the agent install and configure it for you.</p>}
        {onSendToAgent && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => handleAgentSetup(HUBSPOT_CLI_SETUP_PROMPT)}
          >
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
    <div className="preview-install-prompt hubspot-setup">
      <h3>Sign in to HubSpot</h3>
      <p className="hint">
        The HubSpot CLI is installed but not connected to an account. Signing in opens your browser
        to create a personal access key, which the CLI stores locally.
      </p>
      {onSendToAgent && (
        <Button
          variant="primary"
          size="sm"
          onClick={() => handleAgentSetup(HUBSPOT_AUTH_SETUP_PROMPT)}
        >
          Sign in with AI
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={() => setAttempt((a) => a + 1)}>
        <ResetIcon size={14} /> Try again
      </Button>
      <p className="hint">
        Don&apos;t have an account?{' '}
        <button
          type="button"
          className="hubspot-setup-link"
          onClick={() => void openUrl(HUBSPOT_DEVELOPERS_URL)}
        >
          Create a free developer account
        </button>
      </p>
    </div>
  );
}
