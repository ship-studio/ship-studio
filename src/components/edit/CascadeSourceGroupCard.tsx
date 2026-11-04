/** Source heading for one contiguous provenance run in the CSS cascade. */
import { Fragment, type ReactNode } from 'react';
import { ChevronIcon, FileTextIcon } from '@/components/icons';
import { cascadeSourceBackingFile, cascadeSourceFileLabel } from '../../lib/cascadePresentation';
import type { CascadeSourceProvenance, RuleSourceCandidate } from '../../lib/cssCascade';
import { TextButton } from '../primitives/TextButton';

interface Props {
  runKey: string;
  /** Actual source provenance when this run contains an authored rule. */
  source?: CascadeSourceProvenance;
  /** Known write destination when this run contains drafts but no authored rule. */
  destinationFile?: string;
  /** Known source line for a resolved file, used for navigation without changing its label. */
  sourceLine?: number;
  count: number;
  /** Singular count label, such as `selector` or `animation`. */
  itemLabel?: string;
  /** Accessible description for the grouped content, such as `Styles` or `Animations`. */
  groupLabel?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenInCode?: (file: string, line?: number) => void;
  children: ReactNode;
}

/** One collapsible heading for a contiguous run with identical source provenance. */
export function CascadeSourceGroupCard({
  runKey,
  source,
  destinationFile,
  sourceLine,
  count,
  itemLabel = 'selector',
  groupLabel = 'Styles',
  collapsed,
  onToggleCollapse,
  onOpenInCode,
  children,
}: Props) {
  const files = source
    ? source.kind === 'resolved'
      ? [source.file]
      : source.files
    : destinationFile
      ? [destinationFile]
      : [];
  const candidates = source?.kind === 'multiple' ? source.candidates : undefined;
  const targets: RuleSourceCandidate[] | { file: string; line: null }[] = candidates?.length
    ? candidates
    : files.map((file) => ({ file, line: null }));
  const label =
    candidates?.length && source?.kind === 'multiple'
      ? targets
          .map(
            ({ file, line }) => `${cascadeSourceFileLabel(file)}${line == null ? '' : `:${line}`}`
          )
          .join(', ')
      : files.map(cascadeSourceFileLabel).join(', ');
  const title = targets
    .map(({ file, line }) => `${file}${line == null ? '' : `:${line}`}`)
    .join('\n');
  const ambiguous = source?.kind === 'multiple';
  const collapseLabel = source
    ? ambiguous
      ? `ambiguous source rules ${label}`
      : `source file ${label}`
    : `stylesheet destination ${label}`;

  const renderSourceLabel = (file: string, line: number | null, key: string) => {
    const styleSuffix = /\?style=(\d+)$/.exec(file);
    const backingFile = cascadeSourceBackingFile(file);
    const candidateLabel = ambiguous ? 'ambiguous source candidate ' : '';
    const targetLabel = styleSuffix
      ? `embedded style block ${styleSuffix[1]} in ${backingFile}`
      : file;
    const openLabel = `Open ${candidateLabel}${targetLabel} in Code tab`;
    const navigationLine = line ?? sourceLine ?? null;
    const lineLabel = navigationLine == null ? '' : ` at line ${navigationLine}`;

    return (
      <TextButton
        key={key}
        className="ss-cascade-file-group__label ss-cascade-file-group__source-link"
        leftIcon={<FileTextIcon size={12} aria-hidden="true" />}
        title={`Open ${ambiguous ? 'ambiguous source candidate ' : ''}${file}${lineLabel} in Code tab`}
        aria-label={`${openLabel.replace(' in Code tab', '')}${lineLabel} in Code tab`}
        onClick={() => {
          if (navigationLine == null) onOpenInCode?.(file);
          else onOpenInCode?.(file, navigationLine);
        }}
      >
        <span className="ss-cascade-file-group__source-name">
          {cascadeSourceFileLabel(file)}
          {line == null ? '' : `:${line}`}
        </span>
      </TextButton>
    );
  };

  return (
    <section
      className={`ss-cascade-file-group${collapsed ? ' is-collapsed' : ''}`}
      data-testid={source ? 'cascade-source-group' : 'cascade-destination-group'}
      data-source-kind={source?.kind ?? 'destination'}
      data-source-file={source?.kind === 'resolved' ? source.file : undefined}
      data-source-files={
        ambiguous && source?.kind === 'multiple' ? source.files.join('\n') : undefined
      }
      data-destination-file={source ? undefined : destinationFile}
      data-source-group-key={runKey}
      aria-label={
        source
          ? ambiguous
            ? `${groupLabel} with ambiguous source rules: ${label}`
            : `${groupLabel} from ${label}`
          : `${groupLabel} for ${label}`
      }
    >
      <header className="ss-cascade-file-group__head">
        <button
          type="button"
          className={`ss-cascade-card__collapse ss-cascade-file-group__collapse${collapsed ? ' is-collapsed' : ''}`}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${collapseLabel}`}
          onClick={onToggleCollapse}
        >
          <ChevronIcon size={12} />
        </button>
        {ambiguous && <span className="ss-cascade-file-group__status">Ambiguous</span>}
        {source && onOpenInCode ? (
          <span className="ss-cascade-file-group__labels" title={title}>
            {targets.map(({ file, line }, index) => (
              <Fragment key={`${file}-${line ?? 'file'}-${index}`}>
                {index > 0 && (
                  <span className="ss-cascade-file-group__separator" aria-hidden="true">
                    {', '}
                  </span>
                )}
                {renderSourceLabel(file, line, `${file}-${line ?? 'file'}-${index}`)}
              </Fragment>
            ))}
          </span>
        ) : (
          <span className="ss-cascade-file-group__label" title={title}>
            <FileTextIcon size={12} aria-hidden="true" />
            <span className="ss-cascade-file-group__source-name">{label}</span>
          </span>
        )}
        <span className="ss-cascade-file-group__count">
          {count} {count === 1 ? itemLabel : `${itemLabel}s`}
        </span>
      </header>
      {!collapsed && <div className="ss-cascade-file-group__body">{children}</div>}
    </section>
  );
}
