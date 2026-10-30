// VTIMEZONE for an IANA zone, built from the browser's own time zone data (Intl).
// Repeating events keep their wall-clock time across DST changes only with local times + TZID, and CalDAV
// clients (and Radicale's expansion) need the zone's rules in the object itself.
import ICAL from 'ical.js'

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const DAY = 86_400_000

/** The zone of this browser, e.g. Europe/Paris. */
export function localZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** UTC offset of zone at instant, in minutes. */
export function offsetAt(zone: string, instant: number) {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(instant))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0
}

interface Transition {
  /** UTC instant of the change */
  at: number
  from: number
  to: number
}

function transitions(zone: string, year: number): Transition[] {
  const out: Transition[] = []
  let t = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  let offset = offsetAt(zone, t)
  for (; t < end; t += DAY) {
    const next = offsetAt(zone, t + DAY)
    if (next === offset) continue
    // Narrow down to the minute.
    let lo = t
    let hi = t + DAY
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000
      if (offsetAt(zone, mid) === offset) lo = mid
      else hi = mid
    }
    out.push({ at: hi, from: offset, to: next })
    offset = next
  }
  return out
}

/** Wall-clock time of a transition, in the offset before it (as VTIMEZONE DTSTART wants). */
function wallClock(t: Transition) {
  return new Date(t.at + t.from * 60_000)
}

/** BYMONTH/BYDAY of a transition: the nth weekday of the month, or -1 for the last one. */
function ruleOf(t: Transition) {
  const d = wallClock(t)
  const day = d.getUTCDate()
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7)
  return {
    month: d.getUTCMonth() + 1,
    byday: `${nth}${WEEKDAYS[d.getUTCDay()]}`,
    time: d.getUTCHours() * 60 + d.getUTCMinutes()
  }
}

function sameRule(a: ReturnType<typeof ruleOf>, b: ReturnType<typeof ruleOf>) {
  return a.month === b.month && a.byday === b.byday && a.time === b.time
}

function fmtOffset(minutes: number) {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`
}

/**
 * A VTIMEZONE for zone, valid from the given year on. DST changes become yearly rules when they follow one
 * (most zones); otherwise each change of the next 30 years is listed.
 */
export function vtimezone(zone: string, fromYear: number): ICAL.Component {
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`]
  const years = Array.from({ length: 4 }, (_, i) => fromYear + i)
  const perYear = years.map((y) => transitions(zone, y))
  const regular =
    perYear.every((list) => list.length === 2) &&
    [0, 1].every((i) => perYear.every((list) => sameRule(ruleOf(list[i]), ruleOf(perYear[0][i]))))

  if (perYear[0].length === 0 && perYear.every((list) => list.length === 0)) {
    const offset = fmtOffset(offsetAt(zone, Date.UTC(fromYear, 0, 1)))
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, 'END:STANDARD')
  } else if (regular) {
    for (const t of perYear[0]) {
      const rule = ruleOf(t)
      lines.push(
        t.to > t.from ? 'BEGIN:DAYLIGHT' : 'BEGIN:STANDARD',
        `DTSTART:${stamp(wallClock(t))}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${rule.month};BYDAY=${rule.byday}`,
        `TZOFFSETFROM:${fmtOffset(t.from)}`,
        `TZOFFSETTO:${fmtOffset(t.to)}`,
        t.to > t.from ? 'END:DAYLIGHT' : 'END:STANDARD'
      )
    }
  } else {
    const all = Array.from({ length: 30 }, (_, i) => transitions(zone, fromYear + i)).flat()
    const first = all[0]
    const before = fmtOffset(first ? first.from : offsetAt(zone, Date.UTC(fromYear, 0, 1)))
    lines.push('BEGIN:STANDARD', `DTSTART:${fromYear}0101T000000`, `TZOFFSETFROM:${before}`, `TZOFFSETTO:${before}`, 'END:STANDARD')
    for (const t of all) {
      const kind = t.to > t.from ? 'DAYLIGHT' : 'STANDARD'
      const at = stamp(wallClock(t))
      lines.push(`BEGIN:${kind}`, `DTSTART:${at}`, `RDATE:${at}`, `TZOFFSETFROM:${fmtOffset(t.from)}`, `TZOFFSETTO:${fmtOffset(t.to)}`, `END:${kind}`)
    }
  }
  lines.push('END:VTIMEZONE')
  return new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${lines.join('\r\n')}\r\nEND:VCALENDAR`)).getFirstSubcomponent(
    'vtimezone'
  )!
}
