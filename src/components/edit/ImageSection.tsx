/**
 * "Image" section of the visual editor panel, shown when the selection is an
 * `<img>`: the current asset (thumbnail + path) and a Webflow-style Replace
 * button that opens the shared assets browser (`AssetsModal`) in pick mode.
 * Picking writes the new path straight to source (picking IS the save), so
 * there's no dirty state here.
 */

import { useCallback, useState } from 'react';
import { Button } from '../primitives/Button';
import { PropSection } from './PropSection';
import { AssetsModal } from '../AssetsPanel';
import { assetWebPath } from '../../lib/assets';
import type { ElementSignature, ImageResolution } from '../../lib/edit';

interface Props {
  signature: ElementSignature;
  /** null while the backend resolve is in flight. */
  resolution: ImageResolution | null;
  projectPath: string;
  /** Write the picked web path to source (rejects on failure — picker stays open). */
  onReplace: (webPath: string) => Promise<void>;
}

export function ImageSection({ signature, resolution, projectPath, onReplace }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const resolved = resolution?.status === 'resolved';
  // The authored path once resolved (the value a replace will rewrite); before
  // that, the rendered attribute is the best truthful display.
  const displaySrc = resolution?.status === 'resolved' ? resolution.src : (signature.attrSrc ?? '');

  const handlePick = useCallback(
    async (webPath: string) => {
      try {
        await onReplace(webPath);
        setPickerOpen(false);
      } catch {
        // Write failed (toast already shown) — keep the picker open for another try.
      }
    },
    [onReplace]
  );

  return (
    <PropSection title="Image" defaultOpen>
      <div className="ss-edit-image">
        {signature.currentSrc ? (
          <img className="ss-edit-image__thumb" src={signature.currentSrc} alt="" />
        ) : (
          <span className="ss-edit-image__thumb ss-edit-image__thumb--empty" aria-hidden />
        )}
        <div className="ss-edit-image__meta">
          {displaySrc && (
            <code className="ss-edit-image__path" title={displaySrc}>
              {displaySrc}
            </code>
          )}
          {resolved ? (
            <Button size="sm" variant="secondary" block onClick={() => setPickerOpen(true)}>
              Replace image…
            </Button>
          ) : (
            <p className="ss-edit-image__note">
              {resolution ? resolution.reason : 'Locating source…'}
            </p>
          )}
        </div>
      </div>
      <AssetsModal
        projectPath={projectPath}
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        pick={{
          title: 'Replace image',
          onPick: (asset) => void handlePick(assetWebPath(asset.path)),
        }}
      />
    </PropSection>
  );
}
