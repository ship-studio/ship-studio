/**
 * PhoneModal — phone access for the mobile companion: turn it on, pair a
 * phone with a QR code and a click to Allow, and see or remove paired
 * phones.
 *
 * Owns the data: status (re-read on `companion://changed`, so a phone
 * arriving at the desk shows at once, and polled every few seconds while
 * open) and the code it just issued.
 *
 * @module components/phone/PhoneModal
 */

import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { CheckIcon, CloseIcon, ExternalLinkIcon } from '@/components/icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { TAILSCALE_DOWNLOAD_URL } from '../../lib/remoteAccess';
import {
  cancelPairing,
  COMPANION_CHANGED_EVENT,
  decidePairing,
  getPhoneStatus,
  phoneCapabilities,
  phoneStep,
  removePhone,
  retryPhoneTailscale,
  setPhoneAccess,
  shortUrl,
  startPairing,
  takePairOnOpen,
  type Device,
  type PairingCode,
  type PhoneStatus,
  type PhoneStep,
} from '../../lib/companion';
import { PairCode, PairConfirm, PairOffer } from './PhonePairing';
import { PhoneDevices } from './PhoneDevices';

const errMsg = (err: unknown) => formatCommandError(asCommandError(err));

interface PhoneModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PhoneModal({ isOpen, onClose }: PhoneModalProps) {
  const { showToast } = useOptionalToast();
  const status = useAsyncState<PhoneStatus>(getPhoneStatus);
  const { execute: load, setData: setStatus } = status;
  const [code, setCode] = useState<PairingCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { copy } = useCopyToClipboard({
    onCopy: () => showToast('Pairing link copied. It works once, for five minutes.', 'success'),
  });

  const run = useCallback(
    async (key: string, fn: () => Promise<PhoneStatus | void>) => {
      setBusy(key);
      try {
        const next = await fn();
        if (next) setStatus(next);
        else await load();
        return true;
      } catch (err) {
        showToast(errMsg(err), 'error');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load, setStatus, showToast]
  );

  const pair = useCallback(
    () =>
      run('pair', async () => {
        const issued = await startPairing();
        const next = await getPhoneStatus();
        setCode(issued);
        setNow(Date.now());
        return next;
      }),
    [run]
  );

  useEffect(() => {
    if (!isOpen) {
      setCode(null);
      return;
    }
    let unlisten: (() => void) | undefined;
    let closed = false;
    void listen(COMPANION_CHANGED_EVENT, () => void load()).then((fn) => {
      if (closed) fn();
      else unlisten = fn;
    });
    void load().then((s) => {
      // Cmd+K "Pair a phone": straight to the code when it can be shown.
      if (takePairOnOpen() && s && phoneStep(s).kind === 'ready') void pair();
    });
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [isOpen, load, pair]);

  const s = status.data;
  const pairing = s?.pairing;
  const showingCode = code !== null && pairing?.active === true && code.expiresAt > now;

  // Status every few seconds (each read asks Tailscale); the phone arriving
  // at the desk is pushed by `companion://changed` rather than polled for.
  usePolling(
    async () => {
      setNow(Date.now());
      return load();
    },
    { intervalMs: 5000, enabled: isOpen, name: 'phone-access' }
  );
  // The code's countdown: a clock, no backend.
  usePolling(() => Promise.resolve(setNow(Date.now())), {
    intervalMs: 1000,
    enabled: showingCode,
    name: 'phone-code-clock',
  });

  // The code was used, cancelled or ran out: let it go.
  useEffect(() => {
    if (code && pairing && !pairing.active) setCode(null);
  }, [code, pairing]);

  const decide = (allow: boolean) => {
    const name = pairing?.request?.name ?? 'The phone';
    void run('decide', async () => {
      await decidePairing(allow);
      if (allow) showToast(`${name} is paired.`, 'success');
    });
  };

  const remove = (device: Device) =>
    void run('remove', async () => {
      const next = await removePhone(device.id);
      showToast(`Removed ${device.name}.`, 'success');
      return next;
    });

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Phone" className="phone-modal">
      <div className="settings-modal-body phone-access">
        {!s ? (
          <div className="phone-loading">
            {status.error ? (
              <p className="phone-error">Couldn’t read phone access status.</p>
            ) : (
              <Spinner />
            )}
          </div>
        ) : (
          <>
            <AccessHeader
              step={phoneStep(s)}
              busy={busy}
              onEnable={(on) => void run(on ? 'enable' : 'disable', () => setPhoneAccess(on))}
              onRetry={() => void run('retry', retryPhoneTailscale)}
            />

            {phoneStep(s).kind === 'ready' && (
              <section className="phone-section">
                {pairing?.request ? (
                  <PairConfirm device={pairing.request} busy={busy} onDecide={decide} />
                ) : showingCode && code ? (
                  <PairCode
                    code={code}
                    now={now}
                    busy={busy !== null}
                    onCopy={() => void copy(code.link)}
                    onCancel={() => void run('cancel', cancelPairing)}
                  />
                ) : (
                  <PairOffer busy={busy !== null} onPair={() => void pair()} />
                )}
              </section>
            )}

            {(s.enabled || s.devices.length > 0) && (
              <section className="phone-section">
                <h3 className="phone-section__title">Paired phones</h3>
                <PhoneDevices
                  devices={s.devices}
                  activity={s.activity}
                  now={now}
                  busy={busy}
                  onRemove={remove}
                />
                {!s.enabled && s.devices.length > 0 && (
                  <p className="phone-footnote">
                    Phone access is off. These phones stay paired and reconnect when you turn it
                    back on.
                  </p>
                )}
              </section>
            )}

            {s.devices.length > 0 && <PhoneAbilities methods={s.methods} />}
          </>
        )}
      </div>
    </ModalFrame>
  );
}

interface HeaderProps {
  step: PhoneStep;
  busy: string | null;
  onEnable: (on: boolean) => void;
  onRetry: () => void;
}

/** What phone access needs next, or that it's on. */
function AccessHeader({ step, busy, onEnable, onRetry }: HeaderProps) {
  const spin = (key: string) => (busy === key ? <Spinner size="sm" /> : undefined);
  const turnOff = (
    <Button
      size="compact"
      variant="ghost"
      disabled={busy !== null}
      leftIcon={spin('disable')}
      onClick={() => onEnable(false)}
    >
      Turn off
    </Button>
  );

  if (step.kind === 'off') {
    return (
      <div className="phone-intro">
        <p className="phone-lede">
          Talk to your agents from your phone, answer their questions and approve what they ask for.
          The phone connects straight to this Mac over your own Tailscale network. Nothing goes
          through anyone else, and this Mac has to stay on.
        </p>
        <Button
          variant="primary"
          disabled={busy !== null}
          leftIcon={spin('enable')}
          onClick={() => onEnable(true)}
        >
          Turn on phone access
        </Button>
      </div>
    );
  }

  if (step.kind === 'ready') {
    return (
      <div className="phone-onbar">
        <span className="phone-dot" aria-hidden />
        <span className="phone-onbar__text">
          <span className="phone-onbar__title">On for phones on your tailnet</span>
          <span className="phone-onbar__url">{shortUrl(step.url)}</span>
        </span>
        {turnOff}
      </div>
    );
  }

  const problem: Record<
    Exclude<PhoneStep['kind'], 'off' | 'ready'>,
    { title: string; detail: string }
  > = {
    installTailscale: {
      title: 'Install Tailscale',
      detail:
        'Phone access goes over Tailscale, a private network between your own devices. Install it on this Mac and on your phone, and sign in to the same account on both.',
    },
    signInTailscale: {
      title: 'Sign in to Tailscale',
      detail: 'Tailscale is installed on this Mac but not signed in.',
    },
    approveHttps: {
      title: 'Switch on HTTPS in Tailscale',
      detail:
        'Your phone connects with Tailscale’s own certificate for this Mac. Your Tailscale network needs HTTPS certificates switched on, once.',
    },
    failed: { title: 'Tailscale didn’t start phone access', detail: '' },
    starting: { title: 'Starting phone access…', detail: '' },
  };
  const { title, detail } = problem[step.kind];

  return (
    <div className="phone-problem" data-kind={step.kind}>
      <div className="phone-problem__head">
        {step.kind === 'starting' && <Spinner size="sm" />}
        <span className="phone-problem__title">{title}</span>
        {turnOff}
      </div>
      {detail && <p className="phone-problem__detail">{detail}</p>}
      {step.kind === 'failed' && <p className="phone-error">{step.detail}</p>}
      <div className="phone-problem__actions">
        {step.kind === 'installTailscale' && (
          <Button
            variant="primary"
            rightIcon={<ExternalLinkIcon size={12} />}
            onClick={() => void openUrl(TAILSCALE_DOWNLOAD_URL)}
          >
            Get Tailscale
          </Button>
        )}
        {step.kind === 'approveHttps' && (
          <Button
            variant="primary"
            rightIcon={<ExternalLinkIcon size={12} />}
            onClick={() => void openUrl(step.url)}
          >
            Open Tailscale
          </Button>
        )}
        {step.kind !== 'starting' && (
          <Button
            variant="secondary"
            disabled={busy !== null}
            leftIcon={spin('retry')}
            onClick={onRetry}
          >
            {step.kind === 'approveHttps' ? 'I’ve switched it on' : 'Try again'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** What a paired phone can and can't do on this Mac, from what it serves. */
function PhoneAbilities({ methods }: { methods: string[] }) {
  const { can, cannot } = phoneCapabilities(methods);
  return (
    <section className="phone-section">
      <h3 className="phone-section__title">What a paired phone can do</h3>
      <div className="phone-abilities">
        <ul className="phone-abilities__list" aria-label="Can">
          {can.map((line) => (
            <li key={line} className="phone-abilities__item" data-can>
              <CheckIcon size={12} />
              {line}
            </li>
          ))}
        </ul>
        <ul className="phone-abilities__list" aria-label="Can't">
          {cannot.map((line) => (
            <li key={line} className="phone-abilities__item">
              <CloseIcon size={12} />
              {line}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
