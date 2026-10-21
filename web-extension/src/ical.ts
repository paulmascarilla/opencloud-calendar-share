// Pure iCalendar helpers (no OpenCloud dependency), unit-testable under Node.
import ICAL from 'ical.js'

export type GuestResponse = 'pending' | 'accepted' | 'tentative' | 'declined'

export interface Person {
  id: string
  name: string
}

/** Another time a guest proposed (end exclusive; YYYY-MM-DD for all-day, else ISO UTC) */
export interface Proposal {
  start: string
  end: string
  allDay: boolean
}

export interface Guest extends Person {
  response: GuestResponse
  proposal: Proposal | null
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
  /** Which occurrence of a series this is (see {@link occurrenceId}), null for a single event */
  recurrenceId: string | null
  organizer: Person | null
  guests: Guest[]
  /** Set on a guest's copy of an invitation: path of the organizer's event */
  invitationFrom: string | null
  /** RFC 7986 COLOR (a CSS3 color name), overrides the calendar color */
  color: string | null
  /** Shows the user as busy (TRANSP); without TRANSP, timed events are busy and all-day events free */
  busy: boolean
  /** X-OC-VISIBILITY:PUBLIC: people who see the user's availability also see the title and place */
  public: boolean
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
  busy: boolean
  public: boolean
}

/** Turns one calendar-data payload (expanded by the server) into displayable occurrences. */
export function parseInstances(ics: string, href: string, etag: string, calendarHref: string): EventInstance[] {
  const vcalendar = new ICAL.Component(ICAL.parse(withDateRecurrenceIds(ics)))
  registerTimezones(vcalendar)
  const invitationFrom = (vcalendar.getFirstPropertyValue('x-oc-organizer-href') as string | null) ?? null
  return vcalendar.getAllSubcomponents('vevent').map((vevent) => {
    const event = new ICAL.Event(vevent)
    const recurrenceId = occurrenceId(vevent)
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
      // On a copy without X-OC-DESCRIPTION the organizer wrote none: DESCRIPTION only holds the answer links.
      description: original(vevent, 'x-oc-description') ?? (invitationFrom ? '' : event.description || ''),
      // An occurrence of an expanded series, or a stored series itself (single GET)
      recurring: recurrenceId !== null || vevent.hasProperty('rrule') || vevent.hasProperty('rdate'),
      recurrenceId,
      organizer: person(vevent.getFirstProperty('organizer')),
      guests: vevent
        .getAllProperties('attendee')
        .map((p) => {
          const who = person(p)
          return (
            who && {
              ...who,
              response: RESPONSES[String(p.getParameter('partstat') ?? '').toUpperCase()] ?? 'pending',
              proposal: proposalOf(p)
            }
          )
        })
        .filter((g): g is Guest => !!g),
      invitationFrom,
      color: (vevent.getFirstPropertyValue('color') as string | null) ?? null,
      busy: isBusy(vevent, allDay),
      public: isPublic(vevent)
    }
  })
}

/**
 * Radicale's expand writes the RECURRENCE-ID of all-day occurrences as `RECURRENCE-ID:20261020`, without
 * VALUE=DATE: ical.js reads it as a broken date-time and throws.
 */
function withDateRecurrenceIds(ics: string) {
  return ics.replace(/^RECURRENCE-ID([^:\r\n]*):(\d{8})(?=\r?$)/gim, (line, params: string, date: string) =>
    /;VALUE=/i.test(params) ? line : `RECURRENCE-ID${params};VALUE=DATE:${date}`
  )
}

/** RECURRENCE-ID as YYYY-MM-DD or a UTC ISO date-time, comparable between expanded and stored objects. */
function occurrenceId(vevent: ICAL.Component): string | null {
  const time = vevent.getFirstPropertyValue('recurrence-id') as ICAL.Time | null
  if (!time) return null
  return time.isDate ? time.toString() : time.toJSDate().toISOString()
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

/** TRANSP, else the default of Google Calendar and Outlook (the calshare free/busy rule too). */
function isBusy(vevent: ICAL.Component, allDay: boolean) {
  const transp = String(vevent.getFirstPropertyValue('transp') ?? '').toUpperCase()
  return transp ? transp !== 'TRANSPARENT' : !allDay
}

/** Not CLASS:PUBLIC, which some CalDAV clients write on every event (see the calshare free/busy). */
function isPublic(vevent: ICAL.Component) {
  return String(vevent.getFirstPropertyValue('x-oc-visibility') ?? '').toUpperCase() === 'PUBLIC'
}

function setPublic(vevent: ICAL.Component, value: boolean) {
  if (value) vevent.updatePropertyWithValue('x-oc-visibility', 'PUBLIC')
  else vevent.removeAllProperties('x-oc-visibility')
}

/** X-OC-PROPOSED-START / -END on an ATTENDEE (written by the calshare sidecar). */
function proposalOf(prop: ICAL.Property): Proposal | null {
  const start = prop.getParameter('x-oc-proposed-start') as string | undefined
  const end = prop.getParameter('x-oc-proposed-end') as string | undefined
  if (!start || !end) return null
  const iso = (v: string) =>
    v.length === 8
      ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
      : `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`
  return { start: iso(start), end: iso(end), allDay: start.length === 8 }
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
  for (const [name, field] of TEXTS) setText(vevent, name, draft[field] ?? '')
  const now = ICAL.Time.now()
  vevent.updatePropertyWithValue('dtstamp', now)
  vevent.updatePropertyWithValue('last-modified', now)
  vevent.updatePropertyWithValue('sequence', 0)
  setTime(vevent, 'dtstart', toIcalTime(draft.start, draft.allDay))
  setTime(vevent, 'dtend', toIcalTime(draft.end, draft.allDay))
  vevent.updatePropertyWithValue('transp', draft.busy ? 'OPAQUE' : 'TRANSPARENT')
  setPublic(vevent, draft.public)
  return vcalendar.toString()
}

const TEXTS = [
  ['summary', 'title'],
  ['location', 'location'],
  ['description', 'description'],
  ['color', 'color']
] as const

/**
 * Applies to the stored object what changed between ``base`` (the event as the user saw it) and ``draft``.
 * Fields the user left alone keep the stored values, which may have changed elsewhere in the meantime.
 *
 * For a recurring event, ``recurrenceId`` is the occurrence the user edited: an occurrence changed on its own
 * (its own VEVENT) is edited alone; otherwise the series' texts change, and its times never do.
 */
export function updatedEventIcs(ics: string, draft: EventDraft, base: EventDraft, recurrenceId: string | null = null) {
  const vcalendar = new ICAL.Component(ICAL.parse(ics))
  registerTimezones(vcalendar)
  const vevents = vcalendar.getAllSubcomponents('vevent')
  const override = recurrenceId ? vevents.find((v) => occurrenceId(v) === recurrenceId) : undefined
  const master = vevents.find((v) => !v.hasProperty('recurrence-id'))
  const target = override ?? master
  if (!target) throw new Error('no master VEVENT')

  const texts = TEXTS.filter(([, field]) => (draft[field] ?? '') !== (base[field] ?? ''))
  if (target === master) {
    // Occurrences changed on their own follow the series where they still had its texts.
    for (const occurrence of vevents.filter((v) => v !== master)) {
      for (const [name, field] of texts) {
        if (text(occurrence, name) === text(master, name)) setText(occurrence, name, draft[field] ?? '')
      }
    }
  }
  for (const [name, field] of texts) setText(target, name, draft[field] ?? '')

  const timesChanged =
    draft.allDay !== base.allDay ||
    draft.start.getTime() !== base.start.getTime() ||
    draft.end.getTime() !== base.end.getTime()
  if (timesChanged && !recurrenceId) {
    target.removeAllProperties('duration')
    setTime(target, 'dtstart', toIcalTime(draft.start, draft.allDay))
    setTime(target, 'dtend', toIcalTime(draft.end, draft.allDay))
  }

  // Busy / free, written when changed, or kept as shown when the default changes (all-day toggled without TRANSP).
  if (draft.busy !== base.busy || (timesChanged && !recurrenceId && draft.allDay !== base.allDay && !target.hasProperty('transp'))) {
    const transp = draft.busy ? 'OPAQUE' : 'TRANSPARENT'
    if (target === master) {
      for (const occurrence of vevents.filter((v) => v !== master)) {
        if (text(occurrence, 'transp') === text(master, 'transp')) occurrence.updatePropertyWithValue('transp', transp)
      }
    }
    target.updatePropertyWithValue('transp', transp)
  }
  if (draft.public !== base.public) {
    if (target === master) {
      for (const occurrence of vevents.filter((v) => v !== master)) {
        if (isPublic(occurrence) === isPublic(master)) setPublic(occurrence, draft.public)
      }
    }
    setPublic(target, draft.public)
  }

  const now = ICAL.Time.now()
  target.updatePropertyWithValue('dtstamp', now)
  target.updatePropertyWithValue('last-modified', now)
  const sequence = Number(target.getFirstPropertyValue('sequence') ?? -1)
  target.updatePropertyWithValue('sequence', sequence + 1)
  return vcalendar.toString()
}

/** Whether the stored object holds its own VEVENT for this occurrence (changed on its own in a calendar app). */
export function isModifiedOccurrence(ics: string, recurrenceId: string) {
  const vcalendar = new ICAL.Component(ICAL.parse(ics))
  registerTimezones(vcalendar)
  return vcalendar.getAllSubcomponents('vevent').some((v) => occurrenceId(v) === recurrenceId)
}

function text(vevent: ICAL.Component, name: string) {
  return String(vevent.getFirstPropertyValue(name) ?? '')
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
