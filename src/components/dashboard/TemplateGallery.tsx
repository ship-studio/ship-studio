import { useState, useRef, useCallback } from 'react';
import { Button } from '../primitives/Button';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  SearchIcon,
  CloseIcon,
} from '@/components/icons';
import TemplatePlaceholderGraphic from '@/assets/graphics/template-placeholder.svg?react';

/** Shape of a community template from the API */
export interface CommunityTemplate {
  id: string;
  name: string;
  tagline: string;
  category: string;
  thumbnail_url: string | null;
  zip_url: string | null;
  creator: {
    display_name: string;
  };
}

interface TemplateGalleryProps {
  templates: CommunityTemplate[];
  loading: boolean;
  onSelect: (template: CommunityTemplate) => void;
  selectedId: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /**
   * Why the template fetch failed, or null when it succeeded. A failed fetch
   * used to be indistinguishable from a search that matched nothing — both
   * rendered "No templates found", so an offline user was told the gallery was
   * empty (issue #754).
   */
  loadError?: string | null;
  /** Re-runs the fetch behind the error state's retry action. */
  onRetry?: () => void;
}

function SkeletonCard() {
  return (
    <div className="tg-card tg-card-skeleton">
      <div className="tg-card-thumb tg-skeleton-shimmer" />
      <div className="tg-card-body">
        <div className="tg-skeleton-line tg-skeleton-line-title tg-skeleton-shimmer" />
        <div className="tg-skeleton-line tg-skeleton-line-desc tg-skeleton-shimmer" />
        <div className="tg-skeleton-line tg-skeleton-line-author tg-skeleton-shimmer" />
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: CommunityTemplate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`tg-card ${selected ? 'tg-card-selected' : ''}`}
      onClick={onSelect}
    >
      <div className="tg-card-thumb">
        {template.thumbnail_url ? (
          <img src={template.thumbnail_url} alt={template.name} draggable={false} />
        ) : (
          <div className="tg-card-thumb-placeholder">
            <TemplatePlaceholderGraphic width={24} height={24} aria-hidden="true" />
          </div>
        )}
      </div>
      <div className="tg-card-body">
        <span className="tg-card-name">{template.name}</span>
        <span className="tg-card-desc">{template.tagline}</span>
        <span className="tg-card-author">by {template.creator.display_name}</span>
      </div>
      {selected && (
        <div className="tg-card-check">
          <CheckIcon size={14} />
        </div>
      )}
    </button>
  );
}

export function TemplateGallery({
  templates,
  loading,
  onSelect,
  selectedId,
  searchQuery,
  onSearchChange,
  loadError = null,
  onRetry,
}: TemplateGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollButtons = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  const handleScroll = useCallback(() => {
    updateScrollButtons();
  }, [updateScrollButtons]);

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    // 3 cards fill clientWidth (with 2 inner gaps of 10px).
    // The next set of 3 starts at clientWidth + 10px (the gap after card 3).
    const amount = el.clientWidth + 10;
    el.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' });
  };

  // Update scroll buttons when templates load
  const carouselRefCallback = useCallback(
    (node: HTMLDivElement | null) => {
      (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      if (node) {
        // Wait a frame for layout
        requestAnimationFrame(updateScrollButtons);
      }
    },
    [updateScrollButtons]
  );

  const showError = !loading && loadError !== null;
  const showEmpty = !loading && !showError && templates.length === 0;

  return (
    <div className="tg-container">
      <div className="tg-search-wrapper">
        <SearchIcon className="tg-search-icon" size={16} />
        <input
          type="text"
          className="tg-search-input"
          placeholder="Search community templates..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {searchQuery && (
          <button
            type="button"
            className="tg-search-clear"
            title="Clear search"
            aria-label="Clear search"
            onClick={() => onSearchChange('')}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      <div className="tg-carousel-wrapper">
        {!loading && canScrollLeft && (
          <button
            type="button"
            className="tg-scroll-btn tg-scroll-left"
            title="Scroll left"
            aria-label="Scroll left"
            onClick={() => scroll('left')}
          >
            <ArrowLeftIcon size={16} />
          </button>
        )}

        <div className="tg-carousel" ref={carouselRefCallback} onScroll={handleScroll}>
          {loading && (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          )}

          {!loading &&
            templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                selected={selectedId === t.id}
                onSelect={() => onSelect(t)}
              />
            ))}

          {showEmpty && (
            <div className="tg-empty">
              <span>No templates found</span>
            </div>
          )}

          {showError && (
            <div className="tg-empty tg-error">
              <span>Couldn't load templates. {loadError}</span>
              {onRetry && (
                <Button variant="secondary" size="compact" onClick={onRetry}>
                  Try again
                </Button>
              )}
            </div>
          )}
        </div>

        {!loading && canScrollRight && (
          <button
            type="button"
            className="tg-scroll-btn tg-scroll-right"
            title="Scroll right"
            aria-label="Scroll right"
            onClick={() => scroll('right')}
          >
            <ArrowRightIcon size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
