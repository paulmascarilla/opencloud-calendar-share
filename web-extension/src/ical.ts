// Pure iCalendar helpers (no OpenCloud dependency), unit-testable under Node.
import ICAL from 'ical.js'

export type GuestResponse = 'pending' | 'accepted' | 'tentative' | 'declined'

export interface Person {
  id: string
  name: string
}

export interface Guest extends Person {
  response: GuestResponse
}

export interface EventInstance {
  /** Unique per occurrence (resource href + recurrence id) */
  key: string
  href: string
  etag: string
  calendarHref: string
  uid: string
  title: string
  /** ISO date-time (UTC) or YYYY-MM-DD for all-day events */
  start: string
  end: string | null
  allDay: boolean
  location: string
  description: string
  recurring: boolean
  organizer: Person | null
  guests: Guest[]
  /** Set on a guest's copy of an invitation: path of the organizer's event */
  invitationFrom: string | null
  /** RFC 7986 COLOR (a CSS3 color name), overrides the calendar color */
  color: string | null
}

export interface EventDraft {
  calendarHref: string
  title: string
  allDay: boolean
  start: Date
  /** Exclusive end (for all-day events: the day after the last day) */
  end: Date
  location: string
  description: string
  /** OpenCloud guests; the sidecar turns them into invitations */
  guests: Guest[]
  color: string | null
}

/** Turns one calendar-data payload (expanded by the server) into displayable occurrences. */
export function parseInstances(ics: string, href: string, etag: string, calendarHref: string): EventInstance[] {
  const vcalendar = new ICAL.Component(ICAL.parse(ics))
  registerTimezones(vcalendar)
  const invitationFrom = (vcalendar.getFirstPropertyValue('x-oc-organizer-href') as string | null) ?? null
  return vcalendar.getAllSubcomponents('vevent').map((vevent) => {
    const event = new ICAL.Event(vevent)
    const recurrenceId = vevent.getFirstPropertyValue('recurrence-id')
    const allDay = event.startDate.isDate
    return {
      key: `${href}#${recurrenceId ?? ''}`,
      href,
      etag,
      calendarHref,
      uid: event.uid,
      // Guest copies carry a "[À confirmer]" prefix and answer links for CalDAV clients;
      // the web app shows the organizer's original texts instead.
      title: original(vevent, 'x-oc-summary') ?? (event.summary || ''),
      start: allDay ? event.startDate.toString() : event.startDate.toJSDate().toISOString(),
      end: endOf(event, allDay),
      allDay,
      location: event.location || '',
      description: original(vevent, 'x-oc-description') ?? (event.description || ''),
      recurring: recurrenceId !== null,
      organizer: person(vevent.getFirstProperty('organizer')),
      guests: vevent
        .getAllProperties('attendee')
        .map((p) => {
          const who = person(p)
          return who && { ...who, response: RESPONSES[String(p.getParameter('partstat') ?? '').toUpperCase()] ?? 'pending' }
        })
        .filter((g): g is Guest => !!g),
      invitationFrom,
      color: (vevent.getFirstPropertyValue('color') as string | null) ?? null
    }
  })
}

function original(vevent: ICAL.Component, name: string) {
  return vevent.hasProperty(name) ? String(vevent.getFirstPropertyValue(name) ?? '') : null
}

/** Unexpanded objects (single GET) keep local times + VTIMEZONE: teach ical.js the zones. */
function registerTimezones(vcalendar: ICAL.Component) {
  for (const vtimezone of vcalendar.getAllSubcomponents('vtimezone')) {
    const tzid = vtimezone.getFirstPropertyValue('tzid') as string
    if (tzid && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(vtimezone)
  }
}

const RESPONSES: Record<string, GuestResponse> = {
  ACCEPTED: 'accepted',
  TENTATIVE: 'tentative',
  DECLINED: 'declined'
}

/** OpenCloud users carry their id in X-OC-USERID (set by the calshare sidecar). */
function person(prop: ICAL.Property | null): Person | null {
  const id = prop?.getParameter('x-oc-userid') as string | undefined
  if (!id) return null
  return { id, name: (prop!.getParameter('cn') as string | undefined) || id }
}

export function newEventIcs(draft: EventDraft, uid: string) {
  const vcalendar = new ICAL.Component(['vcalendar', [], []])
  vcalendar.addPropertyWithValue('prodid', '-//OpenCloud//calendar//FR')
  vcalendar.addPropertyWithValue('version', '2.0')
  const vevent = new ICAL.Component('vevent')
  vevent.addPropertyWithValue('uid', uid)
  vevent.addPropertyWithValue('created', ICAL.Time.now())
  vcalendar.addSubcomponent(vevent)
  applyDraft(vevent, draft, true)
  return vcalendar.toString()
}

/** Applies ``draft`` to the stored object. For recurring events only the series' texts change. */
export function updatedEventIcs(ics: string, draft: EventDraft, changeTimes: boolean) {
  const vcalendar = new ICAL.Component(ICAL.parse(ics))
  const master = vcalendar.getAllSubcomponents('vevent').find((v) => !v.hasProperty('recurrence-id'))
  if (!master) throw new Error('no master VEVENT')
  applyDraft(master, draft, changeTimes)
  return vcalendar.toString()
}

function applyDraft(vevent: ICAL.Component, draft: EventDraft, changeTimes: boolean) {
  const now = ICAL.Time.now()
  setText(vevent, 'summary', draft.title)
  setText(vevent, 'location', draft.location)
  setText(vevent, 'description', draft.description)
  setText(vevent, 'color', draft.color ?? '')
  vevent.updatePropertyWithValue('dtstamp', now)
  vevent.updatePropertyWithValue('last-modified', now)
  const sequence = Number(vevent.getFirstPropertyValue('sequence') ?? -1)
  vevent.updatePropertyWithValue('sequence', sequence + 1)
  if (!changeTimes) return

  vevent.removeAllProperties('duration')
  setTime(vevent, 'dtstart', toIcalTime(draft.start, draft.allDay))
  setTime(vevent, 'dtend', toIcalTime(draft.end, draft.allDay))
}

function setText(vevent: ICAL.Component, name: string, value: string) {
  if (value.trim()) {
    vevent.updatePropertyWithValue(name, value)
  } else {
    vevent.removeAllProperties(name)
  }
}

function setTime(vevent: ICAL.Component, name: string, time: ICAL.Time) {
  // Replace the property so stale TZID/VALUE parameters don't survive.
  vevent.removeAllProperties(name)
  const prop = new ICAL.Property(name, vevent)
  prop.resetType(time.isDate ? 'date' : 'date-time')
  prop.setValue(time)
  vevent.addProperty(prop)
}

function toIcalTime(date: Date, allDay: boolean) {
  if (allDay) {
    return ICAL.Time.fromData({
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      isDate: true
    })
  }
  return ICAL.Time.fromJSDate(date, true)
}

function endOf(event: ICAL.Event, allDay: boolean) {
  const end = event.endDate
  if (!end || end.compare(event.startDate) <= 0) return null
  return allDay ? end.toString() : end.toJSDate().toISOString()
}
