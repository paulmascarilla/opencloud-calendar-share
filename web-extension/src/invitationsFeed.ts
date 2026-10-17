// Invitations awaiting the user's answer, shared by the top-bar bell and the calendar.
// Created once in the app's setup() (runs at OpenCloud Web startup, whatever app is open),
// so new invitations are noticed everywhere: OpenCloud toast + desktop notification.
import { useMessages, useUserStore } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { ref, watch } from 'vue'
import { PendingInvitation, useCalshare } from './composables/useCalshare'

const POLL_MS = 30_000
const SEEN_KEY = 'calendar.notifiedInvitations'

const pending = ref<PendingInvitation[]>([])
/** Bumped whenever invitations change, so open views can reload. */
const version = ref(0)
const desktopPermission = ref<NotificationPermission | 'unsupported'>(
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
)
let api: ReturnType<typeof createFeed> | null = null

export function useInvitationsFeed() {
  return api!
}

export function startInvitationsFeed() {
  if (!api) api = createFeed()
  return api
}

function createFeed() {
  const calshare = useCalshare()
  const { showMessage } = useMessages()
  const { $gettext } = useGettext()
  const userStore = useUserStore()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false

  const key = (i: PendingInvitation) => `${i.calendar}/${i.event}`

  async function refresh() {
    // Public-link visitors have no calendar.
    if (running || !userStore.user) return
    running = true
    try {
      const list = await calshare.pendingInvitations()
      const before = pending.value.map(key).join()
      pending.value = list
      if (list.map(key).join() !== before) version.value++
      announce(list)
    } catch {
      // sidecar unreachable or not logged in yet: keep the last known state
    } finally {
      running = false
    }
  }

  function announce(list: PendingInvitation[]) {
    const stored = readSeen()
    const seen = new Set(stored ?? [])
    const fresh = list.filter((i) => !seen.has(key(i)))
    // First run on this browser: remember what exists without a burst of notifications.
    if (stored) {
      for (const invitation of fresh) {
        const title = $gettext('New invitation')
        const body = invitation.organizer
          ? $gettext('%{organizer} invites you to “%{title}”', { organizer: invitation.organizer, title: invitation.title })
          : invitation.title
        showMessage({ title, desc: body })
        if (desktopPermission.value === 'granted') {
          try {
            const notification = new Notification(title, { body, tag: key(invitation), icon: '/favicon.ico' })
            notification.onclick = () => {
              window.focus()
              notification.close()
            }
          } catch {
            // some browsers only allow notifications from a service worker
          }
        }
      }
    }
    writeSeen([...new Set([...list.map(key), ...(stored ?? [])])].slice(-200))
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (document.visibilityState === 'visible') await refresh()
      schedule()
    }, POLL_MS)
  }

  async function enableDesktopNotifications() {
    if (typeof Notification === 'undefined') return
    desktopPermission.value = await Notification.requestPermission()
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh()
  })
  // Setup runs before login completes: take the baseline as soon as the user is known,
  // so invitations arriving afterwards are announced.
  watch(
    () => userStore.user?.id,
    (id) => {
      if (id) refresh()
    },
    { immediate: true }
  )
  schedule()

  return { pending, version, desktopPermission, refresh, enableDesktopNotifications }
}

function readSeen(): string[] | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY)
    return raw ? (JSON.parse(raw) as string[]) : null
  } catch {
    return null
  }
}

function writeSeen(keys: string[]) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(keys))
  } catch {
    // storage unavailable: notifications may repeat, nothing else breaks
  }
}
