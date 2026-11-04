/**
 * Paired phones: who, connected now or when last seen, and Remove — with an
 * inline confirmation, because removing means pairing again.
 *
 * @module components/phone/PhoneDevices
 */

import { useState } from 'react';
import { Button } from '../primitives/Button';
import { MobileIcon } from '@/components/icons';
import { deviceLine, presenceLine, type Device } from '../../lib/companion';

interface PhoneDevicesProps {
  devices: Device[];
  now: number;
  busy: string | null;
  onRemove: (device: Device) => void;
}

export function PhoneDevices({ devices, now, busy, onRemove }: PhoneDevicesProps) {
  const [confirming, setConfirming] = useState<string | null>(null);

  if (devices.length === 0) {
    return <p className="phone-empty">No phones paired yet.</p>;
  }
  return (
    <ul className="phone-devices">
      {devices.map((d) => (
        <li key={d.id} className="phone-device" data-connected={d.connected || undefined}>
          <span className="phone-device__icon" aria-hidden>
            <MobileIcon size={16} />
          </span>
          {confirming === d.id ? (
            <>
              <span className="phone-device__body">
                <span className="phone-device__name">Remove {d.name}?</span>
                <span className="phone-device__meta">
                  It disconnects now and has to pair again to come back.
                </span>
              </span>
              <span className="phone-device__actions">
                <Button size="compact" variant="ghost" onClick={() => setConfirming(null)}>
                  Keep
                </Button>
                <Button
                  size="compact"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirming(null);
                    onRemove(d);
                  }}
                >
                  Remove
                </Button>
              </span>
            </>
          ) : (
            <>
              <span className="phone-device__body">
                <span className="phone-device__name">{d.name}</span>
                <span className="phone-device__meta">{deviceLine(d)}</span>
              </span>
              <span className="phone-device__presence">
                {d.connected && <span className="phone-dot" aria-hidden />}
                {presenceLine(d, now)}
              </span>
              <span className="phone-device__actions">
                <Button
                  size="compact"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => setConfirming(d.id)}
                >
                  Remove
                </Button>
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
