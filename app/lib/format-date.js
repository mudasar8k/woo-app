/**
 * Consistent date formatting for SSR + client hydration.
 * Always use an explicit locale — bare toLocaleString() differs between Node and browser.
 */
export function formatDateTime(date) {
  if (!date) return 'Never'

  return new Date(date).toLocaleString('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
}
