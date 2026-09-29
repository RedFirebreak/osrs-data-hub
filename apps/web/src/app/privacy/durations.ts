/** Retention periods as the privacy page shows them. */

/** "30 days", "365 days (1 year)", "730 days (2 years)". */
export function formatDays(days: number): string {
  const unit = days === 1 ? 'day' : 'days';
  if (days >= 365 && days % 365 === 0) {
    const years = days / 365;
    return `${days} ${unit} (${years} ${years === 1 ? 'year' : 'years'})`;
  }
  return `${days} ${unit}`;
}

/** "72 hours (3 days)", "1 hour". */
export function formatHours(hours: number): string {
  const unit = hours === 1 ? 'hour' : 'hours';
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return `${hours} ${unit} (${days} ${days === 1 ? 'day' : 'days'})`;
  }
  return `${hours} ${unit}`;
}
