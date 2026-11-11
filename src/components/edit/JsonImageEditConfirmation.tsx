import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import type { ImageResolution } from '../../lib/edit';

export function JsonImageEditConfirmation({
  resolution,
  value,
  applying,
  onCancel,
  onConfirm,
}: {
  resolution: ImageResolution | null;
  value: string | null;
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (resolution?.status !== 'json_property') return null;

  return (
    <ModalFrame
      isOpen={value !== null}
      title="Update shared image value?"
      onClose={onCancel}
      dismissable={!applying}
    >
      <div className="ss-edit-image__confirm">
        <p>
          This changes <code>{resolution.file}</code> at{' '}
          <code>{resolution.property_path.join('.')}</code>. The authored expression
          <code> {resolution.expression}</code> stays in place.
        </p>
        <p>
          New value: <code>{value}</code>
        </p>
        {resolution.references.length > 0 && (
          <>
            <p>These source references use this property:</p>
            <ul className="ss-edit-image__references">
              {resolution.references.map((reference) => (
                <li key={reference}>{reference}</li>
              ))}
            </ul>
          </>
        )}
        {!resolution.scope_known && (
          <p>Other or dynamic access to this JSON import could not be classified.</p>
        )}
        {resolution.literal_references.length > 0 && (
          <>
            <p>These matching URL literals keep their current value:</p>
            <ul className="ss-edit-image__references">
              {resolution.literal_references.map((reference) => (
                <li key={reference}>{reference}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="modal-actions">
        <Button variant="secondary" disabled={applying} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={applying || value === null} onClick={onConfirm}>
          {applying ? 'Updating…' : 'Update JSON value'}
        </Button>
      </div>
    </ModalFrame>
  );
}
