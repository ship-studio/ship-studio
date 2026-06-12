/**
 * ChangelogModal — "What's New" rendered as a modal.
 *
 * Thin wrapper around the existing Changelog component so the dashboard
 * doesn't have to carry the (tall) version list inline. Triggered from
 * the Preferences card below the project grid.
 */

import { ModalFrame } from '../primitives/ModalFrame';
import { Changelog } from './Changelog';

interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ChangelogModal({ isOpen, onClose }: ChangelogModalProps) {
  if (!isOpen) return null;
  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="What's New" className="changelog-modal">
      <div className="changelog-modal-body">
        <Changelog className="changelog-in-modal" />
      </div>
    </ModalFrame>
  );
}
