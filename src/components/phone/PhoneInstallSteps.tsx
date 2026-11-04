/**
 * The install checklist, and what the panel says once the app is on the
 * phone. Every row is decided by Ship Studio's own checks.
 *
 * @module components/phone/PhoneInstallSteps
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { ExternalLinkIcon, SuccessIcon } from '@/components/icons';
import {
  expiryLine,
  FREE_TEAM_DAYS,
  XCODE_APP_STORE_URL,
  type InstallPlatform,
  type InstallStep,
} from '../../lib/companionInstall';

const WHO: Record<InstallStep['state'], string | null> = {
  done: null,
  agent: 'Claude Code',
  you: 'You',
  waiting: null,
};

export function InstallChecklist({ steps }: { steps: InstallStep[] }) {
  return (
    <ol className="phone-install-steps" aria-label="Install checklist">
      {steps.map((step) => (
        <li key={step.id} className="phone-install-step" data-state={step.state}>
          <span className="phone-install-step__mark" aria-hidden>
            {step.state === 'done' ? <SuccessIcon size={16} /> : <span />}
          </span>
          <span className="phone-install-step__body">
            <span className="phone-install-step__head">
              <span className="phone-install-step__title">{step.title}</span>
              {WHO[step.state] && (
                <span className="phone-install-step__who">{WHO[step.state]}</span>
              )}
            </span>
            <span className="phone-install-step__detail">{step.detail}</span>
            {step.appStore && (
              <Button
                size="compact"
                variant="primary"
                className="phone-install-step__action"
                rightIcon={<ExternalLinkIcon size={12} />}
                onClick={() => void openUrl(XCODE_APP_STORE_URL)}
              >
                {step.appStore}
              </Button>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface DoneProps {
  platform: InstallPlatform;
  deviceName: string;
  expiresAt: number | null;
  now: number;
  opening: boolean;
  onOpen?: () => void;
  onPair: () => void;
}

/** The app is on the phone: when it stops working, then straight to pairing. */
export function InstallDone({
  platform,
  deviceName,
  expiresAt,
  now,
  opening,
  onOpen,
  onPair,
}: DoneProps) {
  return (
    <div className="phone-install-done">
      <span className="phone-install-done__icon" aria-hidden>
        <SuccessIcon size={22} />
      </span>
      <h3 className="phone-install-done__title">Ship Studio is on {deviceName}</h3>
      {platform === 'ios' ? (
        <>
          <p className="phone-install-done__line">
            {expiresAt === null
              ? `With a free Apple ID, it stops opening after ${FREE_TEAM_DAYS} days. `
              : `${expiryLine(expiresAt, now)}. `}
            Reinstall from this panel takes a few minutes and needs no agent, and Ship Studio
            reminds you the day before.
          </p>
          <p className="phone-install-done__hint">
            If the phone says “Untrusted Developer”: Settings → General → VPN &amp; Device
            Management → your Apple ID → Trust.
          </p>
        </>
      ) : (
        <p className="phone-install-done__line">Android builds don’t expire.</p>
      )}
      <div className="phone-install-done__actions">
        {onOpen && (
          <Button
            variant="secondary"
            disabled={opening}
            leftIcon={opening ? <Spinner size="sm" /> : undefined}
            onClick={onOpen}
          >
            Open on phone
          </Button>
        )}
        <Button variant="primary" data-install-pair onClick={onPair}>
          Pair it now
        </Button>
      </div>
    </div>
  );
}
