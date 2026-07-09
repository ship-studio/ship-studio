/**
 * Generic renderer for one control-registry row. Switches on the row's `kind` and
 * delegates to the matching widget, threading a shared render context (the current
 * class, active layer, and the write/reset handlers). This is what lets the panel
 * render an arbitrary list of properties without a bespoke branch per property.
 */

import { SpacingBox } from './SpacingBox';
import { GapControl } from './GapControl';
import { OpacityControl } from './OpacityControl';
import { EnumControlRow } from './EnumControls';
import { ColorField } from './ColorControls';
import { LengthControl } from './LengthControl';
import { CustomCssBox } from './CustomCssBox';
import type { RegistryControl } from '../../lib/editControls';
import type { BoxType, Side, SpacingValue, LayerContext, ResetSpec } from '../../lib/edit';

/** Everything a control row needs to read its value and apply/reset edits. Built
 *  once by the panel and passed to every row. */
export interface ControlRenderCtx {
  currentClass: string;
  layer: LayerContext;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
  onSetSide: (type: BoxType, side: Side, value: SpacingValue) => void;
  onStepGap: (dir: 1 | -1, step?: number) => void;
  /** Rendered colors (getComputedStyle) keyed by CSS prop, to seed color pickers. */
  computed?: Record<string, string | undefined>;
}

export function PropControlRenderer({
  control,
  ctx,
}: {
  control: RegistryControl;
  ctx: ControlRenderCtx;
}) {
  switch (control.kind) {
    case 'spacingBox':
      return (
        <SpacingBox currentClass={ctx.currentClass} layer={ctx.layer} onSetSide={ctx.onSetSide} />
      );
    case 'gap':
      return (
        <GapControl
          currentClass={ctx.currentClass}
          layer={ctx.layer}
          onApplyEnum={ctx.onApplyEnum}
          onReset={ctx.onReset}
          onStepGap={ctx.onStepGap}
        />
      );
    case 'opacity':
      return (
        <OpacityControl
          currentClass={ctx.currentClass}
          layer={ctx.layer}
          onApplyEnum={ctx.onApplyEnum}
          onReset={ctx.onReset}
        />
      );
    case 'enum':
      return (
        <EnumControlRow
          control={control.control}
          currentClass={ctx.currentClass}
          layer={ctx.layer}
          onApplyEnum={ctx.onApplyEnum}
          onReset={ctx.onReset}
        />
      );
    case 'color':
      return (
        <ColorField
          label={control.label}
          css={control.css}
          prefix={control.prefix}
          currentClass={ctx.currentClass}
          layer={ctx.layer}
          onApplyEnum={ctx.onApplyEnum}
          onReset={ctx.onReset}
          computed={ctx.computed}
        />
      );
    case 'length':
      return (
        <LengthControl
          label={control.label}
          prefix={control.prefix}
          css={control.css}
          currentClass={ctx.currentClass}
          layer={ctx.layer}
          onApplyEnum={ctx.onApplyEnum}
          onReset={ctx.onReset}
        />
      );
    case 'custom':
      return (
        <CustomCssBox
          currentClass={ctx.currentClass}
          layer={ctx.layer}
          onApplyEnum={ctx.onApplyEnum}
          onReset={ctx.onReset}
        />
      );
  }
}
