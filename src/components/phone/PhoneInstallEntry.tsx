/**
 * The Phone panel's way into "Install on my phone": an offer, or — once a
 * build from this Mac is on a phone — when it stops working and Reinstall.
 * Also the app-wide reminder the day before a free Apple ID's build expires.
 *
 * @module components/phone/PhoneInstallEntry
 */

import { Button } from '../primitives/Button';
import { DownloadIcon } from '@/components/icons';
import { usePolling } from '../../hooks/usePolling';
import {
  expiryLine,
  readInstallRecord,
  remindIfDue,
  type InstallPlatform,
} from '../../lib/companionInstall';

interface EntryProps {
  now: number;
  onInstall: () => void;
  onReinstall: (platform: InstallPlatform) => void;
}

export function PhoneInstallEntry({ now, onInstall, onReinstall }: EntryProps) {
  const record = readInstallRecord();
  // Reinstall only shouts once the build is about to stop, or has.
  const urgent = record?.expiresAt !== undefined && record.expiresAt - now < 24 * 60 * 60 * 1000;
  return (
    <div className="phone-offer" data-testid="phone-install-entry">
      <span className="phone-offer__icon" aria-hidden>
        <DownloadIcon size={18} />
      </span>
      <div className="phone-offer__body">
        <span className="phone-offer__title">
          {record ? `Built on this Mac for ${record.deviceName}` : 'Install on my phone'}
        </span>
        <span className="phone-offer__detail">
          {record
            ? record.expiresAt
              ? `${expiryLine(record.expiresAt, now)}. Plug it in to reinstall.`
              : 'Plug it in to reinstall a newer build.'
            : 'Get the Ship Studio app onto your iPhone or Android phone.'}
        </span>
      </div>
      {record && (
        <Button variant="ghost" onClick={onInstall}>
          Other phone
        </Button>
      )}
      <Button
        variant={urgent ? 'primary' : 'secondary'}
        data-install-open
        onClick={() => (record ? onReinstall(record.platform) : onInstall())}
      >
        {record ? 'Reinstall' : 'Install…'}
      </Button>
    </div>
  );
}

/** Checks hourly, app-wide, whether the build on the phone stops tomorrow. */
export function useCompanionInstallReminder() {
  usePolling(() => remindIfDue(), { intervalMs: 60 * 60 * 1000, name: 'companion-expiry' });
}
