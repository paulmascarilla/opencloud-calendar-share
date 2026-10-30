// How an event repeats: the subset of RFC 5545 RRULE the editor offers, and the presets built from a start date.
import ICAL from 'ical.js'

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface Repeat {
  freq: Frequency
  /** Every n days / weeks / months / years */
  interval: number
  /** WEEKLY: the days of the week */
  weekdays: Weekday[]
  /** MONTHLY: 'day' = same day of the month, 'weekday' = same nth (or last) weekday */
  monthlyBy: 'day' | 'weekday'
  /** Last day (YYYY-MM-DD, inclusive), or null */
  until: string | null
  /** Number of occurrences, or null */
  count: number | null
}

/** What the editor knows about a stored series. */
export interface SeriesInfo {
  /** The occurrence has its own VEVENT: edits apply to it alone */
  modified: boolean
  repeat: Repeat | null
  /** false: the rule uses parts the editor cannot show (it is kept as is) */
  editable: boolean
}

export type Preset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'monthly-weekday' | 'yearly' | 'custom'

export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[date.getDay()]
}

/** Which week of the month date falls in (1–4), or -1 when it is the last such weekday of the month. */
export function weekOfMonth(date: Date) {
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  return date.getDate() + 7 > daysInMonth ? -1 : Math.ceil(date.getDate() / 7)
}

const base = { interval: 1, weekdays: [] as Weekday[], monthlyBy: 'day' as const, until: null as string | null, count: null as number | null }

/** The rule a preset stands for, for an event starting on start. */
export function presetRepeat(preset: Preset, start: Date): Repeat | null {
  switch (preset) {
    case 'daily':
      return { ...base, freq: 'DAILY' }
    case 'weekdays':
      return { ...base, freq: 'WEEKLY', weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] }
    case 'weekly':
      return { ...base, freq: 'WEEKLY', weekdays: [weekdayOf(start)] }
    case 'monthly':
      return { ...base, freq: 'MONTHLY' }
    case 'monthly-weekday':
      return { ...base, freq: 'MONTHLY', monthlyBy: 'weekday' }
    case 'yearly':
      return { ...base, freq: 'YEARLY' }
    default:
      return null
  }
}

/** The preset a rule matches for this start (end conditions aside), else 'custom'. */
export function presetOf(repeat: Repeat | null, start: Date): Preset {
  if (!repeat) return 'none'
  const presets: Preset[] = ['daily', 'weekdays', 'weekly', 'monthly', 'monthly-weekday', 'yearly']
  return presets.find((p) => sameRule(presetRepeat(p, start)!, repeat)) ?? 'custom'
}

function sameRule(a: Repeat, b: Repeat) {
  return (
    a.freq === b.freq &&
    a.interval === b.interval &&
    (a.freq !== 'WEEKLY' || [...a.weekdays].sort().join() === [...b.weekdays].sort().join()) &&
    (a.freq !== 'MONTHLY' || a.monthlyBy === b.monthlyBy)
  )
}

/** Same rule and same end. */
export function sameRepeat(a: Repeat | null, b: Repeat | null) {
  if (!a || !b) return a === b
  return sameRule(a, b) && a.until === b.until && a.count === b.count
}

/**
 * Reads the series' RRULE. Returns editable=false for what the editor cannot show (several rules, RDATE,
 * BYSETPOS, BYHOUR, …): such rules are left untouched.
 */
export function parseRepeat(master: ICAL.Component, start: ICAL.Time): { repeat: Repeat | null; editable: boolean } {
  const rules = master.getAllProperties('rrule')
  if (!rules.length) return { repeat: null, editable: !master.hasProperty('rdate') }
  if (rules.length > 1 || master.hasProperty('rdate')) return { repeat: null, editable: false }
  const recur = rules[0].getFirstValue() as ICAL.Recur
  const freq = recur.freq as Frequency
  const unsupported = { repeat: null as Repeat | null, editable: false }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return unsupported
  const parts = (recur.parts ?? {}) as Record<string, (string | number)[]>
  const allowed: Record<Frequency, string[]> = {
    DAILY: [],
    WEEKLY: ['BYDAY'],
    MONTHLY: ['BYDAY', 'BYMONTHDAY'],
    YEARLY: ['BYMONTH', 'BYMONTHDAY']
  }
  if (Object.keys(parts).some((p) => !allowed[freq].includes(p))) return unsupported

  const startDate = new Date(start.year, start.month - 1, start.day)
  const repeat: Repeat = { ...base, freq, interval: recur.interval || 1, weekdays: [], monthlyBy: 'day' }
  const byday = (parts.BYDAY ?? []).map(String)
  const bymonthday = (parts.BYMONTHDAY ?? []).map(Number)
  if (freq === 'WEEKLY') {
    if (byday.some((d) => !WEEKDAYS.includes(d as Weekday))) return unsupported
    repeat.weekdays = byday.length ? (byday as Weekday[]) : [weekdayOf(startDate)]
  } else if (freq === 'MONTHLY') {
    // Only the forms the editor writes: the start's day of the month, or the start's nth / last weekday.
    if (byday.length) {
      if (byday.length > 1 || bymonthday.length || byday[0] !== `${weekOfMonth(startDate)}${weekdayOf(startDate)}`)
        return unsupported
      repeat.monthlyBy = 'weekday'
    } else if (bymonthday.length && (bymonthday.length > 1 || bymonthday[0] !== startDate.getDate())) {
      return unsupported
    }
  } else if (freq === 'YEARLY') {
    const bymonth = (parts.BYMONTH ?? []).map(Number)
    if ((bymonth.length && (bymonth.length > 1 || bymonth[0] !== startDate.getMonth() + 1)) ||
      (bymonthday.length && (bymonthday.length > 1 || bymonthday[0] !== startDate.getDate())))
      return unsupported
  }
  if (recur.until) {
    // A date-time UNTIL is an instant: show the local day it falls on.
    const until = recur.until.isDate ? recur.until : ICAL.Time.fromJSDate(recur.until.toJSDate(), false)
    repeat.until = `${until.year}-${pad(until.month)}-${pad(until.day)}`
  }
  if (recur.count) repeat.count = recur.count
  return { repeat, editable: true }
}

/**
 * The RRULE for repeat, for a series starting on start. A timed series ends at the end of its last day (UNTIL is
 * then a UTC date-time, as RFC 5545 wants with a local DTSTART); an all-day one on that date.
 */
export function toRecur(repeat: Repeat, start: Date, allDay: boolean): ICAL.Recur {
  const parts: Record<string, (string | number)[]> = {}
  if (repeat.freq === 'WEEKLY') {
    const days = repeat.weekdays.length ? repeat.weekdays : [weekdayOf(start)]
    parts.BYDAY = WEEKDAYS.filter((d) => days.includes(d))
  }
  if (repeat.freq === 'MONTHLY' && repeat.monthlyBy === 'weekday') {
    parts.BYDAY = [`${weekOfMonth(start)}${weekdayOf(start)}`]
  }
  const data: Record<string, unknown> = { freq: repeat.freq, interval: Math.max(1, repeat.interval), parts }
  if (repeat.until) {
    const [y, m, d] = repeat.until.split('-').map(Number)
    data.until = allDay
      ? ICAL.Time.fromData({ year: y, month: m, day: d, isDate: true })
      : ICAL.Time.fromJSDate(new Date(y, m - 1, d, 23, 59, 59), true)
  } else if (repeat.count) {
    data.count = repeat.count
  }
  return ICAL.Recur.fromData(data as Parameters<typeof ICAL.Recur.fromData>[0])
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}
