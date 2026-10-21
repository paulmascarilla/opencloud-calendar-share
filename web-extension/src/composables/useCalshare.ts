import { useClientService, useConfigStore } from '@opencloud-eu/web-pkg'
import { urlJoin } from '@opencloud-eu/web-client'
import { unref } from 'vue'

export type Permission = 'read' | 'write'

export interface Calendar {
  id: string
  displayName: string
  color: string | null
  components: string[]
  href: string
  shared: boolean
}

export interface Share {
  owner: string
  calendar: string
  user: { id: string; displayName?: string; username?: string | null }
  permission: Permission
  mount: string
  displayName: string | null
  accepted: boolean
  enabledByOwner: boolean
  created: number
  updated: number
}

/** An invitation the current user has not answered yet. */
export interface PendingInvitation {
  calendar: string
  event: string
  title: string
  start: string | null
  allDay: boolean
  recurring: boolean
  organizer: string
}

/** One busy block of someone's calendar: times only, never what the event is. */
export interface BusyBlock {
  /** ISO date-time (UTC), or YYYY-MM-DD for all-day blocks (end exclusive) */
  start: string
  end: string
  allDay: boolean
  status: 'busy' | 'tentative'
  /** Public events only: what the owner chose to show */
  title?: string
  location?: string
}

export interface Availability {
  id: string
  /** false: the person never used a calendar, nothing is known */
  calendar: boolean
  busy: BusyBlock[]
  error?: string
}

export interface FreeBusyOptions {
  /** UID of the event being edited: it does not conflict with itself */
  except?: string
  /** Leave out what the caller already sees (their events, calendars shared with them) */
  omitKnown?: boolean
}

/** Typed client for the calshare sidecar, reached through the OpenCloud proxy at /calshare. */
export function useCalshare() {
  const clientService = useClientService()
  const configStore = useConfigStore()

  function url(...parts: string[]) {
    return urlJoin(unref(configStore.serverUrl), 'calshare', 'v1', ...parts.map(encodeURIComponent))
  }

  async function listCalendars() {
    const { data } = await clientService.httpAuthenticated.get<Calendar[]>(url('calendars'))
    return data
  }

  async function listOutgoing() {
    const { data } = await clientService.httpAuthenticated.get<Share[]>(url('shares'))
    return data
  }

  async function listIncoming() {
    const { data } = await clientService.httpAuthenticated.get<Share[]>(url('shared-with-me'))
    return data
  }

  async function share(calendar: string, user: string, permission: Permission) {
    const { data } = await clientService.httpAuthenticated.put<Share>(
      url('calendars', calendar, 'shares', user),
      { permission }
    )
    return data
  }

  async function unshare(calendar: string, user: string) {
    await clientService.httpAuthenticated.delete(url('calendars', calendar, 'shares', user))
  }

  async function respond(mount: string, accept: boolean) {
    const { data } = await clientService.httpAuthenticated.post<Share>(
      url('shared-with-me', mount, accept ? 'accept' : 'decline')
    )
    return data
  }

  /** Replaces the guest list of an event; the sidecar delivers and syncs the invitations. */
  async function setGuests(calendar: string, event: string, userIds: string[]) {
    const { data } = await clientService.httpAuthenticated.put(url('calendars', calendar, 'events', event, 'guests'), {
      guests: userIds
    })
    return data
  }

  async function answerInvitation(calendar: string, event: string, response: 'accepted' | 'tentative' | 'declined') {
    const { data } = await clientService.httpAuthenticated.post(url('calendars', calendar, 'events', event, 'respond'), {
      response
    })
    return data
  }

  /** Proposes another time for an invitation (ISO dates, or YYYY-MM-DD for all-day, end exclusive). */
  async function propose(calendar: string, event: string, start: string, end: string) {
    const { data } = await clientService.httpAuthenticated.post(url('calendars', calendar, 'events', event, 'propose'), {
      start,
      end
    })
    return data
  }

  /** Moves the event to a guest's proposal, or dismisses it (organizer). */
  async function decideProposal(calendar: string, event: string, guest: string, accept: boolean) {
    const { data } = await clientService.httpAuthenticated.post(
      url('calendars', calendar, 'events', event, 'proposals', guest, accept ? 'accept' : 'decline')
    )
    return data
  }

  async function pendingInvitations() {
    const { data } = await clientService.httpAuthenticated.get<PendingInvitation[]>(url('invitations', 'pending'))
    return data
  }

  /** When people are busy between start and end (at most 20 people, 100 days). */
  async function freeBusy(users: string[], start: Date, end: Date, options: FreeBusyOptions = {}) {
    const { data } = await clientService.httpAuthenticated.get<{ users: Availability[] }>(url('freebusy'), {
      params: {
        users: users.join(','),
        start: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        end: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        ...(options.except ? { except: options.except } : {}),
        ...(options.omitKnown ? { omit: 'known' } : {})
      }
    })
    return data.users
  }

  return {
    listCalendars,
    listOutgoing,
    listIncoming,
    share,
    unshare,
    respond,
    setGuests,
    answerInvitation,
    propose,
    decideProposal,
    pendingInvitations,
    freeBusy
  }
}

/** The server has free/busy turned off (FREEBUSY=false): availability is not shown at all. */
export function isFreeBusyDisabled(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status === 403
}

/** Extracts the sidecar's `{"error": "..."}` message from an axios error, if any. */
export function apiErrorMessage(error: unknown): string | undefined {
  const response = (error as { response?: { data?: { error?: string } } })?.response
  return response?.data?.error
}
