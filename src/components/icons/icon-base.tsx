import {
  forwardRef,
  type ComponentType,
  type ForwardRefExoticComponent,
  type RefAttributes,
  type SVGProps,
} from 'react';

export type IconKind = 'ui' | 'brand';

/** Shared rendering and accessibility props accepted by every semantic icon. */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
  title?: string;
}

/** Build-time metadata connecting a semantic icon export to its source asset and sizing policy. */
export interface IconMeta {
  name: `${string}Icon`;
  source: `icons/${string}.svg` | `icons/old-icons/${string}.svg`;
  kind: IconKind;
  defaultSize: number;
  compact?: boolean;
  strokeWidth?: number | string;
}

export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>> & {
  iconMeta: IconMeta;
};

/**
 * Apply the compatibility sizing policy shared by every semantic icon.
 * Standard icons use 16px and compact controls use 14px while preserving
 * explicitly requested sizes outside the legacy 12/14px cases.
 */
export function resolveIconSize(size: number, compact = false): number {
  if (compact && (size === 12 || size === 14)) return 14;
  if (!compact && size === 12) return 14;
  if (!compact && size === 14) return 16;
  return size;
}

function isLabelled(props: IconProps): boolean {
  return Boolean(props.title || props['aria-label'] || props['aria-labelledby']);
}

/** Creates a ref-forwarding semantic icon component with consistent sizing and accessibility defaults. */
export function createIcon(
  Asset: ComponentType<SVGProps<SVGSVGElement>>,
  meta: IconMeta
): IconComponent {
  const AssetWithTitle = Asset as ComponentType<SVGProps<SVGSVGElement> & { title?: string }>;
  const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
    { size, title, role, 'aria-hidden': ariaHidden, ...props },
    ref
  ) {
    const labelled = isLabelled({ ...props, title });
    const resolvedSize = resolveIconSize(size ?? meta.defaultSize, meta.compact);

    return (
      <AssetWithTitle
        {...props}
        ref={ref}
        title={title}
        width={resolvedSize}
        height={resolvedSize}
        {...(meta.strokeWidth === undefined ? {} : { strokeWidth: meta.strokeWidth })}
        data-icon-name={meta.name}
        data-icon-kind={meta.kind}
        data-icon-source={meta.source}
        role={labelled ? (role ?? 'img') : role}
        aria-hidden={labelled ? ariaHidden : (ariaHidden ?? true)}
      />
    );
  }) as IconComponent;

  Icon.displayName = meta.name;
  Icon.iconMeta = meta;
  return Icon;
}
