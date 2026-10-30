// Unit tests of the repeat rules and time zones (no server): pnpm test:unit
import assert from 'node:assert/strict'
import ICAL from 'ical.js'
import { vtimezone } from '../src/timezone'

// A generated VTIMEZONE converts local times like the browser does, in summer and in winter, for years ahead.
for (const zone of ['Europe/Paris', 'America/New_York', 'Australia/Sydney', 'Asia/Tokyo', 'America/Sao_Paulo']) {
  const tz = new ICAL.Timezone(vtimezone(zone, 2026))
  for (const month of [1, 7]) {
    const local = ICAL.Time.fromData({ year: 2035, month, day: 15, hour: 9, minute: 30 }, tz)
    const back = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(local.toJSDate())
    assert.equal(back, '09:30', `${zone} 2035-${month}-15`)
  }
}
console.log('ok vtimezone matches Intl for 5 zones, summer and winter, 9 years ahead')

// --- rules --------------------------------------------------------------------------------------------------
import { EventDraft, newEventIcs, parseInstances, seriesInfo, updatedEventIcs, withoutOccurrenceIcs } from '../src/ical'
import { presetOf, presetRepeat, Preset, Repeat } from '../src/repeat'

assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Paris', 'run with TZ=Europe/Paris')

const tue = new Date(2026, 9, 20, 9, 0) // Tuesday 20 Oct 2026, 09:00 Paris (summer time)
const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  calendarHref: '/caldav/u/cal/', title: 'Point', allDay: false, start: tue, end: new Date(2026, 9, 20, 9, 30),
  location: '', description: '', guests: [], color: null, busy: true, public: false, repeat: null, ...over })

/** Local start times (YYYY-MM-DD HH:MM) of the first n occurrences, EXDATE and changed occurrences applied. */
function occurrences(ics: string, n: number) {
  const vcal = new ICAL.Component(ICAL.parse(ics))
  for (const vtz of vcal.getAllSubcomponents('vtimezone')) {
    if (!ICAL.TimezoneService.has(vtz.getFirstPropertyValue('tzid') as string)) ICAL.TimezoneService.register(vtz)
  }
  const vevents = vcal.getAllSubcomponents('vevent')
  const event = new ICAL.Event(vevents.find((v) => !v.hasProperty('recurrence-id'))!)
  vevents.filter((v) => v.hasProperty('recurrence-id')).forEach((v) => event.relateException(v))
  const out: string[] = []
  const it = event.iterator()
  for (let next = it.next(); next && out.length < n; next = it.next()) {
    const d = event.getOccurrenceDetails(next).startDate
    const js = d.isDate ? new Date(d.year, d.month - 1, d.day) : d.toJSDate()
    const p = (x: number) => String(x).padStart(2, '0')
    out.push(`${js.getFullYear()}-${p(js.getMonth() + 1)}-${p(js.getDate())}` + (d.isDate ? '' : ` ${p(js.getHours())}:${p(js.getMinutes())}`))
  }
  return out
}

// Presets: what each one writes, and that it reads back as the same preset.
const expected: Record<Exclude<Preset, 'none' | 'custom'>, [string, string[]]> = {
  daily: ['FREQ=DAILY', ['2026-10-20 09:00', '2026-10-21 09:00', '2026-10-22 09:00']],
  weekdays: ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', ['2026-10-20 09:00', '2026-10-21 09:00', '2026-10-22 09:00', '2026-10-23 09:00', '2026-10-26 09:00']],
  // across the DST change of 25 Oct: still 09:00
  weekly: ['FREQ=WEEKLY;BYDAY=TU', ['2026-10-20 09:00', '2026-10-27 09:00', '2026-11-03 09:00']],
  monthly: ['FREQ=MONTHLY', ['2026-10-20 09:00', '2026-11-20 09:00', '2026-12-20 09:00']],
  'monthly-weekday': ['FREQ=MONTHLY;BYDAY=3TU', ['2026-10-20 09:00', '2026-11-17 09:00', '2026-12-15 09:00']],
  yearly: ['FREQ=YEARLY', ['2026-10-20 09:00', '2027-10-20 09:00']]
}
for (const [preset, [rule, dates]] of Object.entries(expected)) {
  const ics = newEventIcs(draft({ repeat: presetRepeat(preset as Preset, tue) }), 'p')
  assert.match(ics, new RegExp(`RRULE:${rule}\\r\\n`), preset)
  assert.match(ics, /DTSTART;TZID=Europe\/Paris:20261020T090000/, `${preset}: local time with TZID`)
  assert.match(ics, /BEGIN:VTIMEZONE/, preset)
  assert.deepEqual(occurrences(ics, dates.length), dates, preset)
  const info = seriesInfo(ics, null)
  assert.equal(presetOf(info.repeat, info.start), preset, `${preset} reads back`)
  assert.equal(info.editable, true)
}
console.log('ok presets: RRULE, local time + VTIMEZONE, occurrences across DST, read back')

// The last Tuesday of a month is "-1TU", not "4TU".
const lastTue = new Date(2026, 9, 27, 9, 0)
assert.match(newEventIcs(draft({ start: lastTue, end: new Date(2026, 9, 27, 10), repeat: presetRepeat('monthly-weekday', lastTue) }), 'l'),
  /RRULE:FREQ=MONTHLY;BYDAY=-1TU/)
console.log('ok last weekday of the month')

// Ends: until a day (inclusive, whole local day) or after n times.
const custom: Repeat = { freq: 'WEEKLY', interval: 2, weekdays: ['MO', 'TH'], monthlyBy: 'day', until: '2026-11-19', count: null }
let ics = newEventIcs(draft({ repeat: custom }), 'c')
assert.match(ics, /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261119T225959Z/)
// Tuesday is not one of the days: the series starts on the first of them (Thursday).
assert.match(ics, /DTSTART;TZID=Europe\/Paris:20261022T090000/)
assert.match(ics, /DTEND;TZID=Europe\/Paris:20261022T093000/)
assert.deepEqual(occurrences(ics, 20), ['2026-10-22 09:00', '2026-11-02 09:00', '2026-11-05 09:00', '2026-11-16 09:00', '2026-11-19 09:00'])
assert.deepEqual(seriesInfo(ics, null).repeat, custom)
ics = newEventIcs(draft({ repeat: { ...custom, until: null, count: 3 } }), 'c')
assert.deepEqual(occurrences(ics, 20), ['2026-10-22 09:00', '2026-11-02 09:00', '2026-11-05 09:00'])
console.log('ok custom rule, until (inclusive) and count')

// All-day yearly until a date.
const birthday = draft({ allDay: true, start: new Date(2026, 2, 14), end: new Date(2026, 2, 15), repeat: { ...presetRepeat('yearly', new Date(2026, 2, 14))!, until: '2028-03-14' } })
ics = newEventIcs(birthday, 'b')
assert.match(ics, /DTSTART;VALUE=DATE:20260314/)
assert.match(ics, /RRULE:FREQ=YEARLY;UNTIL=20280314\r\n/)
assert.deepEqual(occurrences(ics, 9), ['2026-03-14', '2027-03-14', '2028-03-14'])
console.log('ok all-day yearly until a date')

// A single event (stored in UTC) that starts repeating moves to local time.
const single = newEventIcs(draft(), 's')
assert.match(single, /DTSTART:20261020T070000Z/)
ics = updatedEventIcs(single, draft({ repeat: presetRepeat('weekly', tue) }), draft())
assert.match(ics, /DTSTART;TZID=Europe\/Paris:20261020T090000/)
assert.deepEqual(occurrences(ics, 2), ['2026-10-20 09:00', '2026-10-27 09:00'])
// ... and stops: back to a single event, its changed occurrences and exceptions dropped.
const weekly = draft({ repeat: presetRepeat('weekly', tue) })
let stopped = withoutOccurrenceIcs(ics, '2026-10-27T08:00:00.000Z')
stopped = updatedEventIcs(stopped, draft(), weekly)
assert.doesNotMatch(stopped, /RRULE:FREQ=WEEKLY|EXDATE/)
assert.deepEqual(occurrences(stopped, 5), ['2026-10-20 09:00'])
console.log('ok start and stop repeating')

// Deleting one occurrence (EXDATE in the zone of DTSTART), also one that was changed on its own.
const series = newEventIcs(weekly, 'w')
let without = withoutOccurrenceIcs(series, '2026-10-27T08:00:00.000Z') // 27 Oct 09:00 Paris (winter time)
assert.match(without, /EXDATE;TZID=Europe\/Paris:20261027T090000/)
assert.deepEqual(occurrences(without, 3), ['2026-10-20 09:00', '2026-11-03 09:00', '2026-11-10 09:00'])
const withOverride = series.replace('END:VCALENDAR', [
  'BEGIN:VEVENT', 'UID:w', 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;TZID=Europe/Paris:20261103T090000',
  'DTSTART;TZID=Europe/Paris:20261103T140000', 'DTEND;TZID=Europe/Paris:20261103T143000', 'SUMMARY:Point déplacé', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))
assert.deepEqual(occurrences(withOverride, 3), ['2026-10-20 09:00', '2026-10-27 09:00', '2026-11-03 14:00'])
without = withoutOccurrenceIcs(withOverride, '2026-11-03T08:00:00.000Z')
assert.doesNotMatch(without, /Point déplacé/)
assert.deepEqual(occurrences(without, 3), ['2026-10-20 09:00', '2026-10-27 09:00', '2026-11-10 09:00'])
console.log('ok delete one occurrence, also a changed one')

// Moving one occurrence moves the series: exceptions follow. Here: Tuesday 27 Oct 09:00 -> Wednesday 28 Oct 10:00.
let moved = withoutOccurrenceIcs(withOverride, '2026-11-10T08:00:00.000Z')
const occ = draft({ start: new Date(2026, 9, 27, 9), end: new Date(2026, 9, 27, 9, 30), repeat: weekly.repeat })
moved = updatedEventIcs(moved, { ...occ, start: new Date(2026, 9, 28, 10), end: new Date(2026, 9, 28, 11), repeat: presetRepeat('weekly', new Date(2026, 9, 21)) }, occ, '2026-10-27T08:00:00.000Z')
assert.match(moved, /DTSTART;TZID=Europe\/Paris:20261021T100000/)
assert.match(moved, /DTEND;TZID=Europe\/Paris:20261021T110000/)
assert.match(moved, /RRULE:FREQ=WEEKLY;BYDAY=WE/)
assert.match(moved, /EXDATE;TZID=Europe\/Paris:20261111T100000/)
assert.match(moved, /RECURRENCE-ID;TZID=Europe\/Paris:20261104T100000/)
assert.deepEqual(occurrences(moved, 4), ['2026-10-21 10:00', '2026-10-28 10:00', '2026-11-03 14:00', '2026-11-18 10:00'])
console.log('ok move the series from one occurrence, exceptions follow')

// A rule the editor cannot show survives an edit of the title.
const odd = newEventIcs(draft(), 'o').replace('END:VEVENT', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1\r\nEND:VEVENT')
const info = seriesInfo(odd, null)
assert.deepEqual([info.repeat, info.editable], [null, false])
const renamed = updatedEventIcs(odd, draft({ title: 'Renamed' }), draft())
assert.match(renamed, /RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1/)
assert.match(renamed, /SUMMARY:Renamed/)
console.log('ok unsupported rule kept untouched')

// Expanded occurrences (as Radicale sends them) still read as recurring.
assert.equal(parseInstances(series, '/x.ics', '', '/c/')[0].recurring, true)
console.log('ok all repeat tests passed')
