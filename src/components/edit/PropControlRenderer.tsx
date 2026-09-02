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
import { ValuePropertyControl } from './ValuePropertyControl';
import type {
  BoxType,
  Side,
  SpacingValue,
  LayerContext,
  ResetSpec,
  InheritedProp,
  EnumControl,
} from '../../lib/edit';
import type { RegistryControl } from '../../lib/editControls';
import type { ValueFieldVariable } from '../primitives/ValueField';

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
  variables?: ValueFieldVariable[];
  /** Values this element INHERITS from ancestor elements' styles, keyed by CSS
   *  prop (typography + text color only). Controls surface them when nothing is
   *  set locally across the cascade. */
  inherited?: Record<string, InheritedProp>;
  /** Project root — the inheritance popover resolves the defining ancestor's source. */
  projectPath?: string;
  /** Jump to a source file:line in the Code tab (inheritance popover's link). */
  onOpenInCode?: (file: string, line: number) => void;
}

/** Resolved provenance props the ancestry-aware controls forward to their label. */
function inheritLabelProps(
  ctx: ControlRenderCtx,
  key: string | null
): {
  inherited: InheritedProp | null;
  projectPath?: string;
  onOpenInCode?: (file: string, line: number) => void;
} {
  return {
    inherited: (key ? ctx.inherited?.[key] : undefined) ?? null,
    projectPath: ctx.projectPath,
    onOpenInCode: ctx.onOpenInCode,
  };
}

/** Free-form value kinds → the CSS property whose ancestor-inheritance they
 *  surface. Only genuinely CSS-inherited properties map (border/radius/z-index/
 *  blur never inherit). */
const VALUE_INHERIT_KEYS: Partial<Record<string, string>> = {
  'font-size': 'font-size',
  'line-height': 'line-height',
  'letter-spacing': 'letter-spacing',
};

/** An enum control's single CSS property, derived from its options' shared style
 *  key (Weight's options all set 'font-weight', Style's 'font-style', …). Null
 *  when the options don't share exactly one key — such a control has no single
 *  inheritance story to surface. */
function enumInheritKey(control: EnumControl): string | null {
  if (!control.options.length) return null;
  const first = Object.keys(control.options[0].style);
  if (first.length !== 1) return null;
  const key = first[0];
  return control.options.every((o) => Object.keys(o.style)[0] === key && o.style[key] != null)
    ? key
    : null;
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
    case 'value':
      return (
        <ValuePropertyControl
          kind={control.valueType}
          currentClass={ctx.currentClass}
          layer={ctx.layer}
          onApplyEnum={ctx.onApplyEnum}
          onReset={ctx.onReset}
          variables={ctx.variables}
          {...inheritLabelProps(ctx, VALUE_INHERIT_KEYS[control.valueType] ?? null)}
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
          {...inheritLabelProps(ctx, enumInheritKey(control.control))}
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
          variables={ctx.variables}
          {...inheritLabelProps(ctx, control.prefix === 'text' ? 'color' : null)}
        />
      );
    case 'length':
      return (
        <LengthControl
          label={control.label}
          prefix={control.prefix}
          css={control.css}
          valueType={control.valueType}
          currentClass={ctx.currentClass}
          layer={ctx.layer}
          onApplyEnum={ctx.onApplyEnum}
          onReset={ctx.onReset}
          variables={ctx.variables}
        />
      );
    case 'custom':
      return (
        <CustomCssBox
          key={`${ctx.currentClass}:${ctx.layer.bp.name}`}
          currentClass={ctx.currentClass}
          layer={ctx.layer}
          variables={ctx.variables}
          onApplyEnum={ctx.onApplyEnum}
          onReset={ctx.onReset}
        />
      );
  }
}
