import { useState, useRef, useCallback } from 'react';

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
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </svg>
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
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
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

  const showEmpty = !loading && templates.length === 0;

  return (
    <div className="tg-container">
      <div className="tg-search-wrapper">
        <svg
          className="tg-search-icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
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
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
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
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
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
        </div>

        {!loading && canScrollRight && (
          <button
            type="button"
            className="tg-scroll-btn tg-scroll-right"
            title="Scroll right"
            aria-label="Scroll right"
            onClick={() => scroll('right')}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
