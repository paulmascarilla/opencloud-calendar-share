import type { Proposal } from './ical'

/** "jeu. 12 nov., 11:00 – 12:00", or "ven. 13 nov." for an all-day proposal (end exclusive). */
export function formatProposal(proposal: Proposal, locale: string) {
  if (proposal.allDay) {
    const first = new Date(`${proposal.start}T00:00:00`)
    const last = new Date(`${proposal.end}T00:00:00`)
    last.setDate(last.getDate() - 1)
    const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' })
    return last > first ? day.formatRange(first, last) : day.format(first)
  }
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).formatRange(new Date(proposal.start), new Date(proposal.end))
}
