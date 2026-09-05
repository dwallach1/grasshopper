'use client';

import { VENUE_FILTERS, type VenueFilter } from '../../lib/desk-venue';

export function VenueFilterBar({
  value,
  onChange,
}: {
  value: VenueFilter;
  onChange: (next: VenueFilter) => void;
}) {
  return (
    <div className="term-venues" role="tablist" aria-label="Desk venue">
      {VENUE_FILTERS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          className={value === item.id ? 'on' : ''}
          onClick={() => onChange(item.id)}
        >
          <span className="term-venues-full">{item.label}</span>
          <span className="term-venues-short">{item.short}</span>
        </button>
      ))}
    </div>
  );
}

export function VenueMark({ venue }: { venue: 'equity' | 'prediction' }) {
  return <i className={`term-venue-tag ${venue}`}>{venue === 'prediction' ? 'PM' : 'EQ'}</i>;
}
