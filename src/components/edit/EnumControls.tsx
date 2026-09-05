/**
 * Renders the visual editor's enum controls, each in its configured variant:
 *  - icons     → segmented buttons with an icon per option (align / justify / items)
 *  - dropdown  → a custom themed dropdown (weight, size, radius, …)
 *  - segmented → text buttons
 * All variants apply the option's token + inline-style preview via onApplyEnum.
 */

import type { ReactNode } from 'react';
import {
  activeEnumToken,
  readLayer,
  enumResetSpec,
  type EnumControl,
  type InheritedProp,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';
import { EnumDropdown } from './EnumDropdown';
import { ResettableLabel } from './ResettableLabel';
import { SegmentedControl } from '../primitives/SegmentedControl';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CloseIcon,
} from '@/components/icons';
import { EyeIcon, EyeOffIcon } from '@/components/icons';
import {
  AlignItemsBaselineIcon,
  AlignItemsCenterIcon,
  AlignItemsEndIcon,
  AlignItemsStartIcon,
  AlignItemsStretchIcon,
  AlignCenterIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  DecorationNoneIcon,
  DecorationOverlineIcon,
  DecorationStrikeIcon,
  DecorationUnderlineIcon,
  DisplayBlockIcon,
  DisplayFlexIcon,
  DisplayGridIcon,
  DisplayInlineBlockIcon,
  DisplayInlineFlexIcon,
  ItalicsOffIcon,
  ItalicsOnIcon,
  JustifyAroundIcon,
  JustifyBetweenIcon,
  JustifyCenterIcon,
  JustifyEndIcon,
  JustifyStartIcon,
  OverflowAutoIcon,
  OverflowScrollIcon,
  WrapUpIcon,
  WrapDownIcon,
} from '@/components/icons';

function EnumGlyph({ children }: { children: ReactNode }) {
  return (
    <span className="ss-enum-glyph" aria-hidden="true">
      {children}
    </span>
  );
}

/** Icon per option token (only icon-variant controls need these). */
const ICONS: Record<string, ReactNode> = {
  'text-left': <AlignLeftIcon />,
  'text-center': <AlignCenterIcon />,
  'text-right': <AlignRightIcon />,
  'text-justify': <AlignJustifyIcon />,
  'justify-start': <JustifyStartIcon />,
  'justify-center': <JustifyCenterIcon />,
  'justify-end': <JustifyEndIcon />,
  'justify-between': <JustifyBetweenIcon />,
  'justify-around': <JustifyAroundIcon />,
  'items-baseline': <AlignItemsBaselineIcon />,
  'items-start': <AlignItemsStartIcon />,
  'items-center': <AlignItemsCenterIcon />,
  'items-end': <AlignItemsEndIcon />,
  'items-stretch': <AlignItemsStretchIcon />,
  block: <DisplayBlockIcon />,
  flex: <DisplayFlexIcon />,
  grid: <DisplayGridIcon />,
  'inline-block': <DisplayInlineBlockIcon />,
  'inline-flex': <DisplayInlineFlexIcon />,
  inline: <DisplayInlineBlockIcon />,
  hidden: <EyeOffIcon />,
  'flex-row': <ArrowRightIcon />,
  'flex-row-reverse': <ArrowLeftIcon />,
  'flex-col': <ArrowDownIcon />,
  'flex-col-reverse': <ArrowUpIcon />,
  'flex-nowrap': <CloseIcon />,
  'flex-wrap': <WrapDownIcon />,
  'flex-wrap-reverse': <WrapUpIcon />,
  'overflow-visible': <EyeIcon />,
  'overflow-auto': <OverflowAutoIcon />,
  'overflow-hidden': <EyeOffIcon />,
  'overflow-scroll': <OverflowScrollIcon />,
  'normal-case': <EnumGlyph>Ab</EnumGlyph>,
  uppercase: <EnumGlyph>AB</EnumGlyph>,
  lowercase: <EnumGlyph>ab</EnumGlyph>,
  capitalize: <EnumGlyph>Aa</EnumGlyph>,
  'not-italic': <ItalicsOffIcon />,
  italic: <ItalicsOnIcon />,
  'no-underline': <DecorationNoneIcon />,
  underline: <DecorationUnderlineIcon />,
  overline: <DecorationOverlineIcon />,
  'line-through': <DecorationStrikeIcon />,
};

interface Props {
  currentClass: string;
  /** The active breakpoint layer — controls read the effective value across the
   *  Tailwind cascade and apply at this layer (the hook adds the variant prefix). */
  layer: LayerContext;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  /** Clear a control's value at the active breakpoint. */
  onReset: (spec: ResetSpec) => void;
  /** Ancestor-defined value for this control's CSS property. */
  inherited?: InheritedProp | null;
  projectPath?: string;
  onOpenInCode?: (file: string, line: number) => void;
}

/** One enum control row (icons / dropdown / segmented) with its resettable label.
 *  Placed individually by the control registry, so each can live in any section. */
export function EnumControlRow({
  control,
  currentClass,
  layer,
  onApplyEnum,
  onReset,
  inherited = null,
  projectPath,
  onOpenInCode,
}: { control: EnumControl } & Props) {
  const { value: active, definedAt } = readLayer(currentClass, layer, (s) =>
    activeEnumToken(s, control, layer.utilityPrefix)
  );

  // With nothing set locally, an attributed ancestor token preselects its option
  // (the orange label signals it isn't actually set on this element). Adopting
  // writes that same option locally.
  const inheritedOption =
    inherited?.token != null
      ? (control.options.find((option) => option.token === inherited.token) ?? null)
      : null;
  const shown = active ?? inheritedOption?.token ?? null;
  const adopt = inheritedOption
    ? () => onApplyEnum(inheritedOption.token, inheritedOption.style)
    : undefined;

  let body: ReactNode;
  if (control.label === 'Display') {
    const primaryDefaults = control.options.filter((option) =>
      ['block', 'flex', 'grid', 'hidden'].includes(option.token)
    );
    const activeIsPrimary = primaryDefaults.some((option) => option.token === shown);
    const selectedOverflow =
      !activeIsPrimary && shown
        ? (control.options.find((option) => option.token === shown) ?? null)
        : null;
    const displacedPrimary = selectedOverflow
      ? (primaryDefaults[primaryDefaults.length - 1] ?? null)
      : null;
    const primary = selectedOverflow
      ? [...primaryDefaults.slice(0, -1), selectedOverflow]
      : primaryDefaults;
    const more = control.options.filter(
      (option) => !primaryDefaults.includes(option) && option.token !== selectedOverflow?.token
    );
    const overflowOptions = displacedPrimary ? [...more, displacedPrimary] : more;
    const apply = (token: string) => {
      const option = control.options.find((candidate) => candidate.token === token);
      if (option) onApplyEnum(option.token, option.style);
    };
    body = (
      <div className="ss-edit-panel__display-controls">
        <SegmentedControl
          className="ss-edit-panel__segmented ss-edit-panel__segmented--icons"
          value={shown ?? ''}
          size="medium"
          options={primary.map((option) => ({
            value: option.token,
            label: ICONS[option.token],
            ariaLabel: option.label,
            title: option.label,
          }))}
          aria-label={control.label}
          onValueChange={apply}
        />
        <EnumDropdown
          label="More display options"
          value={shown}
          options={overflowOptions}
          optionIcons={ICONS}
          compactTrigger
          onChange={apply}
        />
      </div>
    );
  } else if (control.variant === 'dropdown') {
    body = (
      <EnumDropdown
        label={control.label}
        value={shown}
        options={control.options}
        onChange={(token) => {
          const opt = control.options.find((o) => o.token === token);
          if (opt) onApplyEnum(opt.token, opt.style);
        }}
      />
    );
  } else if (control.label === 'Align') {
    body = (
      <SegmentedControl
        className="ss-edit-panel__align-tabs"
        value={shown ?? ''}
        size="medium"
        options={control.options.map((option) => ({
          value: option.token,
          label: ICONS[option.token],
          ariaLabel: option.label,
          title: option.label,
        }))}
        aria-label={control.label}
        onValueChange={(token) => {
          const option = control.options.find((candidate) => candidate.token === token);
          if (option) onApplyEnum(option.token, option.style);
        }}
      />
    );
  } else {
    const isIcons = control.variant === 'icons';
    body = (
      <SegmentedControl
        className={`ss-edit-panel__segmented${isIcons ? ' ss-edit-panel__segmented--icons' : ''}`}
        value={shown ?? ''}
        size="medium"
        options={control.options.map((option) => ({
          value: option.token,
          label: isIcons ? ICONS[option.token] : option.label,
          ariaLabel: option.label,
          title: option.label,
        }))}
        aria-label={control.label}
        onValueChange={(token) => {
          const option = control.options.find((candidate) => candidate.token === token);
          if (option) onApplyEnum(option.token, option.style);
        }}
      />
    );
  }

  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label={control.label}
        definedAt={definedAt}
        active={layer.bp}
        onReset={() => onReset(enumResetSpec(control, layer.utilityPrefix))}
        inherited={inherited}
        onAdopt={adopt}
        projectPath={projectPath}
        onOpenInCode={onOpenInCode}
      />
      {body}
    </div>
  );
}
