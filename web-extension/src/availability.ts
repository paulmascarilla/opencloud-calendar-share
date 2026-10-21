// Availability maths for the scheduling timeline and the "People" overlay. Pure (no OpenCloud
// dependency), times in epoch milliseconds, days in the browser's time zone.
import type { BusyBlock } from './composables/useCalshare'

export type BusyStatus = 'busy' | 'tentative'

/** Someone whose busy times are drawn over the calendar ("People" in the sidebar) */
export interface WatchedPerson {
  id: string
  name: string
  color: string
  hidden?: boolean
}

export interface Interval {
  start: number
  end: number
  status: BusyStatus
  allDay: boolean
  /** A public event's title */
  title?: string
}

const MINUTE = 60_000
const DAY = 86_400_000

/** YYYY-MM-DD as local midnight. */
export function localDay(day: string) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Midnight of the day holding `date` (local). */
export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes())
}

/** Busy blocks as intervals; all-day blocks cover whole local days, as they do in the calendar. */
export function intervals(blocks: BusyBlock[]): Interval[] {
  return blocks.map((b) => ({
    start: b.allDay ? localDay(b.start).getTime() : Date.parse(b.start),
    end: b.allDay ? localDay(b.end).getTime() : Date.parse(b.end),
    status: b.status,
    allDay: b.allDay,
    title: b.title
  }))
}

/** The strongest status between start and end: busy, tentative, or null when free. */
export function statusBetween(list: Interval[], start: number, end: number): BusyStatus | null {
  let found: BusyStatus | null = null
  for (const i of list) {
    if (i.start < end && i.end > start) {
      if (i.status === 'busy') return 'busy'
      found = 'tentative'
    }
  }
  return found
}

export interface SlotOptions {
  /** Earliest and latest local hour of a suggestion (working hours) */
  dayStart?: number
  dayEnd?: number
  /** Suggest Saturdays and Sundays too */
  weekends?: boolean
  /** How far to look, in days */
  horizon?: number
  /** Never before this instant (now) */
  notBefore?: number
}

/**
 * The first start at or after `from`, on a quarter hour within working hours, where nobody in
 * `people` is busy or tentative for `durationMs`. null if there is none within the horizon.
 */
export function nextFreeSlot(people: Interval[][], from: Date, durationMs: number, options: SlotOptions = {}) {
  const { dayStart = 8, dayEnd = 19, weekends = false, horizon = 14, notBefore = Date.now() } = options
  const step = 15 * MINUTE
  const limit = from.getTime() + horizon * DAY
  const all = people.flat().sort((a, b) => a.start - b.start)
  let t = Math.ceil(Math.max(from.getTime(), notBefore) / step) * step
  while (t < limit) {
    const at = new Date(t)
    const day = at.getDay()
    const opens = new Date(at.getFullYear(), at.getMonth(), at.getDate(), dayStart).getTime()
    const closes = new Date(at.getFullYear(), at.getMonth(), at.getDate(), dayEnd).getTime()
    if ((!weekends && (day === 0 || day === 6)) || t + durationMs > closes) {
      t = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, dayStart).getTime()
      continue
    }
    if (t < opens) {
      t = opens
      continue
    }
    // Jump past the conflict that ends last, instead of trying every quarter hour inside it.
    let blockedUntil = 0
    for (const i of all) {
      if (i.start >= t + durationMs) break
      if (i.end > t) blockedUntil = Math.max(blockedUntil, i.end)
    }
    if (!blockedUntil) return at
    t = Math.ceil(blockedUntil / step) * step
  }
  return null
}
