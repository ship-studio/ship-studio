import { ImageIcon } from '@/components/icons';
import type { BackgroundLayerKind } from '../../lib/cssBackgroundImage';
import { SegmentedControl } from '../primitives/SegmentedControl';

const TYPE_OPTIONS = [
  { value: 'image', label: <ImageIcon size={16} />, ariaLabel: 'Image', title: 'Image' },
  {
    value: 'linear',
    label: (
      <span
        className="ss-background-layer-popover__gradient-icon ss-background-layer-popover__gradient-icon--linear"
        aria-hidden="true"
      />
    ),
    ariaLabel: 'Linear gradient',
    title: 'Linear gradient',
  },
  {
    value: 'radial',
    label: (
      <span
        className="ss-background-layer-popover__gradient-icon ss-background-layer-popover__gradient-icon--radial"
        aria-hidden="true"
      />
    ),
    ariaLabel: 'Radial gradient',
    title: 'Radial gradient',
  },
  {
    value: 'solid',
    label: <span className="ss-background-layer-popover__solid-icon" aria-hidden="true" />,
    ariaLabel: 'Solid color',
    title: 'Solid color',
  },
] as const;

export function BackgroundLayerTypeSelector({
  kind,
  onChange,
}: {
  kind: BackgroundLayerKind;
  onChange: (kind: BackgroundLayerKind) => void;
}) {
  return (
    <div className="ss-background-layer-popover__type">
      <SegmentedControl
        className="ss-background-layer-popover__type-options"
        value={kind}
        aria-label="Layer type"
        options={TYPE_OPTIONS}
        onValueChange={onChange}
      />
    </div>
  );
}
