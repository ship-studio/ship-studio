/**
 * Control registry for the visual editor panel.
 *
 * Each property the panel can edit is one declarative row here, grouped into
 * collapsible sections. The panel renders sections → rows generically (see
 * `PropControlRenderer`), so adding a property is a data change, not a new
 * component. The `kind` discriminator picks the widget + its reader/writer:
 *   - `enum`       discrete Tailwind utilities (a dropdown or icon segmented set)
 *   - `color`      a swatch + color picker writing an arbitrary value
 *   - `spacingBox` the box-model padding/margin widget
 *   - `positionBox` the inner box-model ring for position offsets
 *   - `gap`        the gap stepper + free-form field
 *   - `opacity`    the opacity slider
 *
 * All rows funnel through the same `onApplyEnum(token, style)` / `onReset(spec)`
 * path, so breakpoints, the inherited-vs-set cascade, Reset and multi-location all
 * work for every row without per-control wiring.
 */

import { ENUM_CONTROLS, COLOR_CONTROLS, type EnumControl, type ColorPrefix } from './edit';

export type RegistryControl =
  | { kind: 'spacingBox'; key: string }
  | { kind: 'positionBox'; key: string }
  | { kind: 'gap'; key: string }
  | { kind: 'opacity'; key: string }
  | {
      kind: 'value';
      key: string;
      valueType:
        | 'border'
        | 'radius'
        | 'z-index'
        | 'blur'
        | 'font-size'
        | 'line-height'
        | 'letter-spacing';
    }
  | { kind: 'enum'; key: string; control: EnumControl }
  | { kind: 'color'; key: string; label: string; css: string; prefix: ColorPrefix }
  | {
      kind: 'length';
      key: string;
      label: string;
      prefix: string;
      css: string;
      valueType: 'size' | 'min-size' | 'max-size';
    }
  | { kind: 'custom'; key: string };

/** A sizing (length) row: width / height / max-width / min-height. */
function lengthRow(
  label: string,
  prefix: string,
  css: string,
  valueType: 'size' | 'min-size' | 'max-size' = 'size'
): RegistryControl {
  return { kind: 'length', key: `length:${prefix}`, label, prefix, css, valueType };
}

export interface ControlSection {
  id: string;
  title: string;
  /** Whether the section starts expanded (common ones do; the long tail collapses). */
  defaultOpen: boolean;
  controls: RegistryControl[];
}

/** Reference one of the declared enum controls by its label. Throws at module load
 *  if the label is misspelled, so a bad registry entry fails fast in dev/tests. */
function enumRow(label: string): RegistryControl {
  const control = ENUM_CONTROLS.find((c) => c.label === label);
  if (!control) throw new Error(`editControls: unknown enum control "${label}"`);
  return { kind: 'enum', key: `enum:${label}`, control };
}

/** Reference one of the declared color controls by its Tailwind prefix. */
function colorRow(prefix: ColorPrefix): RegistryControl {
  const c = COLOR_CONTROLS.find((x) => x.prefix === prefix);
  if (!c) throw new Error(`editControls: unknown color control "${prefix}"`);
  return { kind: 'color', key: `color:${prefix}`, label: c.label, css: c.css, prefix: c.prefix };
}

function valueRow(
  valueType:
    | 'border'
    | 'radius'
    | 'z-index'
    | 'blur'
    | 'font-size'
    | 'line-height'
    | 'letter-spacing'
): RegistryControl {
  return { kind: 'value', key: `value:${valueType}`, valueType };
}

/** The panel's sections, in render order. Layout leads, then Size & Spacing / Typography;
 *  Backgrounds & Borders, Effects and Custom CSS
 *  collapse to keep the panel calm. */
export const CONTROL_SECTIONS: ControlSection[] = [
  {
    id: 'layout',
    title: 'Layout',
    defaultOpen: true,
    controls: [
      enumRow('Display'),
      enumRow('Direction'),
      enumRow('Wrap'),
      enumRow('Justify'),
      enumRow('Align items'),
      { kind: 'gap', key: 'gap' },
      enumRow('Overflow'),
    ],
  },
  {
    id: 'size',
    title: 'Size & Spacing',
    defaultOpen: true,
    controls: [
      lengthRow('Width', 'w', 'width'),
      lengthRow('Height', 'h', 'height'),
      lengthRow('Min W', 'min-w', 'min-width', 'min-size'),
      lengthRow('Min H', 'min-h', 'min-height', 'min-size'),
      lengthRow('Max W', 'max-w', 'max-width', 'max-size'),
      lengthRow('Max H', 'max-h', 'max-height', 'max-size'),
      { kind: 'spacingBox', key: 'spacingBox' },
    ],
  },
  {
    id: 'position',
    title: 'Position',
    defaultOpen: true,
    controls: [
      enumRow('Position'),
      { kind: 'positionBox', key: 'positionBox' },
      valueRow('z-index'),
    ],
  },
  {
    id: 'typography',
    title: 'Typography',
    defaultOpen: true,
    controls: [
      enumRow('Font'),
      valueRow('font-size'),
      enumRow('Weight'),
      valueRow('line-height'),
      valueRow('letter-spacing'),
      enumRow('Align'),
      enumRow('Transform'),
      enumRow('Style'),
      enumRow('Decoration'),
      colorRow('text'),
    ],
  },
  {
    id: 'backgrounds',
    title: 'Backgrounds & Borders',
    defaultOpen: false,
    controls: [
      colorRow('bg'),
      valueRow('border'),
      colorRow('border'),
      valueRow('radius'),
      enumRow('Shadow'),
    ],
  },
  {
    id: 'effects',
    title: 'Effects',
    defaultOpen: false,
    controls: [{ kind: 'opacity', key: 'opacity' }, valueRow('blur'), enumRow('Cursor')],
  },
  {
    id: 'custom',
    title: 'Custom CSS',
    defaultOpen: true,
    controls: [{ kind: 'custom', key: 'custom' }],
  },
];
