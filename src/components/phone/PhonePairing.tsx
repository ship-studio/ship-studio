/**
 * The three moments of pairing: offer to pair, show the code, and ask
 * whether to allow the phone that used it.
 *
 * The confirmation is the point. A QR code photographed over a shoulder
 * gets a stranger as far as this prompt, with their phone's name on it.
 *
 * @module components/phone/PhonePairing
 */

import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { CopyIcon, MobileIcon, WarningIcon } from '@/components/icons';
import {
  deviceLine,
  expiresIn,
  type PairRequestDevice,
  type PairingCode,
} from '../../lib/companion';
import { PhoneQr } from './PhoneQr';

interface OfferProps {
  busy: boolean;
  onPair: () => void;
}

export function PairOffer({ busy, onPair }: OfferProps) {
  return (
    <div className="phone-offer">
      <span className="phone-offer__icon" aria-hidden>
        <MobileIcon size={18} />
      </span>
      <div className="phone-offer__body">
        <span className="phone-offer__title">Pair a phone</span>
        <span className="phone-offer__detail">
          Scan a one-time code with the Ship Studio app, then allow the phone here.
        </span>
      </div>
      <Button variant="primary" disabled={busy} onClick={onPair}>
        Show code
      </Button>
    </div>
  );
}

interface CodeProps {
  code: PairingCode;
  now: number;
  busy: boolean;
  onCopy: () => void;
  onCancel: () => void;
}

export function PairCode({ code, now, busy, onCopy, onCancel }: CodeProps) {
  const left = expiresIn(code.expiresAt, now);
  return (
    <div className="phone-code" data-testid="phone-pair-code">
      <PhoneQr
        size={code.qr.size}
        modules={code.qr.modules}
        label="Pairing code for the Ship Studio phone app"
      />
      <div className="phone-code__side">
        <span className="phone-code__title">Scan with the Ship Studio app</span>
        <ol className="phone-code__steps">
          <li>Open Ship Studio on your phone.</li>
          <li>Tap Pair, then point the camera at this code.</li>
          <li>Allow the phone here when it asks.</li>
        </ol>
        <span className="phone-code__expiry">{left ? `Works once, for ${left}` : 'Expired'}</span>
        <div className="phone-code__actions">
          <TextButton leftIcon={<CopyIcon size={12} />} onClick={onCopy}>
            Copy link instead
          </TextButton>
          <TextButton disabled={busy} onClick={onCancel}>
            Cancel
          </TextButton>
        </div>
      </div>
    </div>
  );
}

interface ConfirmProps {
  device: PairRequestDevice;
  busy: string | null;
  onDecide: (allow: boolean) => void;
}

export function PairConfirm({ device, busy, onDecide }: ConfirmProps) {
  return (
    <div className="phone-confirm" role="alertdialog" aria-labelledby="phone-confirm-title">
      <span className="phone-confirm__icon" aria-hidden>
        <MobileIcon size={20} />
      </span>
      <h3 id="phone-confirm-title" className="phone-confirm__title">
        Allow <strong>{device.name}</strong> to use your agents?
      </h3>
      <p className="phone-confirm__device">{deviceLine(device)}</p>
      <p className="phone-confirm__warning">
        <WarningIcon size={13} />
        Only allow a phone you’re holding. It will be able to read and send messages to every agent.
      </p>
      <div className="phone-confirm__actions">
        <Button variant="secondary" disabled={busy !== null} onClick={() => onDecide(false)}>
          Deny
        </Button>
        <Button variant="primary" disabled={busy !== null} onClick={() => onDecide(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}
