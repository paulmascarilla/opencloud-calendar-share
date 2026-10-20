import { useClientService, useConfigStore, useUserStore } from '@opencloud-eu/web-pkg'
import { unref } from 'vue'
import { EventDraft, EventInstance, isModifiedOccurrence, newEventIcs, parseInstances, updatedEventIcs } from '../ical'

export type { EventDraft, EventInstance }

export interface CalendarSource {
  /** Absolute path of the collection, e.g. /caldav/<user>/def-calendar/ */
  href: string
  /** Last path segment: collection id for own calendars, mount name for shared ones */
  id: string
  name: string
  color: string
  writable: boolean
  /** Changes whenever an event of the calendar changes (CalendarServer getctag) */
  ctag: string
}

export class ConflictError extends Error {}

const DEFAULT_COLOR = '#3b82f6'
const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav'
const DAV_NS = 'DAV:'
const ICAL_NS = 'http://apple.com/ns/ical/'
const CS_NS = 'http://calendarserver.org/ns/'

/** Minimal CalDAV client talking to Radicale through the OpenCloud proxy (/caldav). */
export function useCaldav() {
  const clientService = useClientService()
  const configStore = useConfigStore()
  const userStore = useUserStore()

  function url(href: string) {
    return new URL(href, unref(configStore.serverUrl)).toString()
  }

  async function dav(method: string, href: string, body?: string, headers: Record<string, string> = {}) {
    // Never answer a GET from the browser cache: its ETag would be stale if the event changed elsewhere,
    // and the next If-Match write would fail.
    const noCache: Record<string, string> = method === 'GET' ? { 'Cache-Control': 'no-cache' } : {}
    const response = await clientService.httpAuthenticated.request<string>({
      method,
      url: url(href),
      data: body,
      headers: { 'Content-Type': 'application/xml; charset=utf-8', ...noCache, ...headers },
      responseType: 'text',
      transformResponse: (data: string) => data,
      validateStatus: () => true
    })
    if (response.status === 412) {
      throw new ConflictError('precondition failed')
    }
    if (response.status >= 400) {
      throw new Error(`${method} ${href}: HTTP ${response.status}`)
    }
    return response
  }

  async function listCalendars(): Promise<CalendarSource[]> {
    const home = `/caldav/${unref(userStore.user)?.id}/`
    const { data } = await dav(
      'PROPFIND',
      home,
      `<?xml version="1.0"?>
      <D:propfind xmlns:D="DAV:" xmlns:C="${CALDAV_NS}" xmlns:I="${ICAL_NS}" xmlns:CS="${CS_NS}">
        <D:prop><D:resourcetype/><D:displayname/><I:calendar-color/><CS:getctag/><D:sync-token/>
          <C:supported-calendar-component-set/><D:current-user-privilege-set/></D:prop>
      </D:propfind>`,
      { Depth: '1' }
    )
    const calendars: CalendarSource[] = []
    for (const response of responses(data)) {
      const prop = response.getElementsByTagNameNS(DAV_NS, 'prop')[0]
      if (!prop?.getElementsByTagNameNS(CALDAV_NS, 'calendar').length) continue
      const components = [...prop.getElementsByTagNameNS(CALDAV_NS, 'comp')].map((c) => c.getAttribute('name'))
      if (components.length && !components.includes('VEVENT')) continue
      const href = decodeURIComponent(text(response, DAV_NS, 'href'))
      const privileges = [...prop.getElementsByTagNameNS(DAV_NS, 'privilege')].map((p) => p.firstElementChild?.localName)
      const id = href.replace(/\/$/, '').split('/').pop()!
      calendars.push({
        href,
        id,
        name: text(prop, DAV_NS, 'displayname') || id,
        // Apple's format may carry an alpha channel (#RRGGBBAA)
        color: (text(prop, ICAL_NS, 'calendar-color') || DEFAULT_COLOR).slice(0, 7),
        writable: privileges.some((p) => p === 'write' || p === 'write-content' || p === 'all'),
        ctag: text(prop, CS_NS, 'getctag') || text(prop, DAV_NS, 'sync-token')
      })
    }
    return calendars
  }

  async function fetchEvents(calendar: CalendarSource, start: Date, end: Date): Promise<EventInstance[]> {
    const range = `start="${utcStamp(start)}" end="${utcStamp(end)}"`
    const { data } = await dav(
      'REPORT',
      calendar.href,
      `<?xml version="1.0"?>
      <C:calendar-query xmlns:D="DAV:" xmlns:C="${CALDAV_NS}">
        <D:prop><D:getetag/><C:calendar-data><C:expand ${range}/></C:calendar-data></D:prop>
        <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
          <C:time-range ${range}/>
        </C:comp-filter></C:comp-filter></C:filter>
      </C:calendar-query>`,
      { Depth: '1' }
    )
    const events: EventInstance[] = []
    for (const response of responses(data)) {
      const ics = text(response, CALDAV_NS, 'calendar-data')
      if (!ics) continue
      const href = decodeURIComponent(text(response, DAV_NS, 'href'))
      const etag = text(response, DAV_NS, 'getetag')
      try {
        events.push(...parseInstances(ics, href, etag, calendar.href))
      } catch (error) {
        // One unreadable event must not hide the rest of the calendar.
        console.warn(`calendar: skipping ${href}`, error)
      }
    }
    return events
  }

  /** Returns the href of the new event. */
  async function createEvent(draft: EventDraft) {
    const uid = crypto.randomUUID()
    const href = `${draft.calendarHref}${uid}.ics`
    await dav('PUT', href, newEventIcs(draft, uid), {
      'Content-Type': 'text/calendar; charset=utf-8',
      'If-None-Match': '*'
    })
    return href
  }

  /**
   * Applies to ``event`` what changed from ``base`` to ``draft``, moving it when ``draft.calendarHref`` differs.
   * Returns its href.
   */
  async function updateEvent(event: EventInstance, draft: EventDraft, base: EventDraft) {
    const href = event.href
    const { data, headers } = await dav('GET', href)
    const ics = updatedEventIcs(data, draft, base, event.recurrenceId)
    const etag = headers.etag as string | undefined

    if (draft.calendarHref && !href.startsWith(draft.calendarHref)) {
      // Moving to another calendar: write the copy first, then remove the original.
      const target = `${draft.calendarHref}${href.split('/').pop()}`
      await dav('PUT', target, ics, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'If-None-Match': '*'
      })
      await dav('DELETE', href, undefined, etag ? { 'If-Match': etag } : {})
      return target
    }
    await dav('PUT', href, ics, {
      'Content-Type': 'text/calendar; charset=utf-8',
      ...(etag ? { 'If-Match': etag } : {})
    })
    return href
  }

  /** Creates an event calendar in the user's home; returns its href. */
  async function createCalendar(name: string, color: string) {
    const id = `cal-${crypto.randomUUID().slice(0, 8)}`
    const href = `/caldav/${unref(userStore.user)?.id}/${id}/`
    await dav(
      'MKCALENDAR',
      href,
      `<?xml version="1.0" encoding="utf-8"?>
      <C:mkcalendar xmlns:D="DAV:" xmlns:C="${CALDAV_NS}" xmlns:I="${ICAL_NS}">
        <D:set><D:prop>
          <D:displayname>${xmlEscape(name)}</D:displayname>
          <I:calendar-color>${xmlEscape(color)}</I:calendar-color>
          <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
        </D:prop></D:set>
      </C:mkcalendar>`
    )
    return href
  }

  /** One stored event (master occurrence), or null if it does not exist. */
  async function getEvent(href: string): Promise<EventInstance | null> {
    try {
      const { data, headers } = await dav('GET', href)
      const calendarHref = href.slice(0, href.lastIndexOf('/') + 1)
      const instances = parseInstances(data, href, (headers.etag as string) ?? '', calendarHref)
      return instances.find((i) => !i.recurrenceId) ?? instances[0] ?? null
    } catch {
      return null
    }
  }

  /** Whether this occurrence of a series was changed on its own (edits then apply to it alone). */
  async function isModified(event: EventInstance) {
    if (!event.recurrenceId) return false
    const { data } = await dav('GET', event.href)
    return isModifiedOccurrence(data, event.recurrenceId)
  }

  async function deleteEvent(href: string, etag?: string) {
    await dav('DELETE', href, undefined, etag ? { 'If-Match': etag } : {})
  }

  return { listCalendars, createCalendar, fetchEvents, getEvent, createEvent, updateEvent, isModified, deleteEvent }
}

function xmlEscape(text: string) {
  return text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`)
}

function utcStamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function responses(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  return [...doc.getElementsByTagNameNS(DAV_NS, 'response')]
}

function text(element: Element, ns: string, name: string) {
  return element.getElementsByTagNameNS(ns, name)[0]?.textContent?.trim() ?? ''
}
