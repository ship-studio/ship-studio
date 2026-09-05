import { LayersIcon } from '@/components/icons';
import { MediaQueryChips } from './MediaQueryChips';

/** Renders the selector, at-rule, and inheritance context for a CSS declaration. */
export function RuleContextChips({
  mediaText,
  layer,
  container,
  supports,
  onRenameAtRule,
}: {
  mediaText?: string | null;
  layer?: string | null;
  container?: string | null;
  supports?: string | null;
  onRenameAtRule?: (newMedia: string) => void;
}) {
  return (
    <>
      {layer && (
        <span className="ss-cascade-card__chip ss-cascade-card__chip--layer">
          <LayersIcon size={10} />
          {layer}
        </span>
      )}
      {/* `@container` / `@supports` are read-only context (we don't yet edit their
          condition in place), shown in full so the card states its real scope. */}
      {container && (
        <span className="ss-cascade-card__chip ss-cascade-card__chip--at">
          <span className="ss-cascade-card__media-at">@container</span> {container}
        </span>
      )}
      {supports && (
        <span className="ss-cascade-card__chip ss-cascade-card__chip--at">
          <span className="ss-cascade-card__media-at">@supports</span> {supports}
        </span>
      )}
      {mediaText &&
        (onRenameAtRule ? (
          <MediaQueryChips condition={mediaText} onCommit={onRenameAtRule} />
        ) : (
          <MediaQueryChips condition={mediaText} />
        ))}
    </>
  );
}
