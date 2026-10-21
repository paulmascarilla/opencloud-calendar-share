<template>
  <div class="ext:flex ext:h-full ext:min-h-0 ext:bg-role-surface">
    <aside
      :class="[
        'ext:w-64 ext:shrink-0 ext:overflow-y-auto ext:p-4 ext:border-r ext:border-role-outline-variant ext:bg-role-surface-container-low',
        sidebarOpen ? 'ext:block' : 'ext:hidden ext:md:block'
      ]"
    >
      <calendar-list
        :calendars="calendars"
        :hidden="hidden"
        :owners="owners"
        @toggle="toggleCalendar"
        @create="creatingCalendar = true"
      />
    </aside>

    <div class="ext:flex ext:flex-col ext:flex-1 ext:min-w-0 ext:px-4 ext:md:px-6 ext:py-4 ext:gap-4">
      <!-- page header -->
      <div class="ext:flex ext:flex-col ext:gap-3">
        <div class="ext:flex ext:flex-wrap ext:items-center ext:gap-3">
          <oc-button
            appearance="raw"
            class="ext:md:hidden"
            :aria-label="$gettext('Show calendars')"
            @click="sidebarOpen = !sidebarOpen"
          >
            <oc-icon name="menu" />
          </oc-button>
          <h1 class="ext:m-0 ext:text-2xl ext:font-semibold ext:flex-1">{{ $gettext('Calendar') }}</h1>
          <oc-search-bar
            class="search ext:w-full ext:sm:w-72"
            :label="$gettext('Search events')"
            :placeholder="$gettext('Search events')"
            :small="true"
            :type-ahead="true"
            :is-filter="true"
            :button-hidden="true"
            @search="onSearch"
          />
        </div>
        <filter-tabs v-model="filter" class="ext:self-start" :tabs="tabs" :label="$gettext('Show')" />
      </div>

      <oc-notification-message
        v-if="loadError"
        status="danger"
        :title="$gettext('Could not load your calendars')"
        :message="loadError"
      />

      <!-- calendar card -->
      <section
        class="oc-calendar ext:flex ext:flex-col ext:flex-1 ext:min-h-0 ext:rounded-xl ext:border ext:border-role-outline-variant ext:bg-role-surface ext:overflow-hidden"
      >
        <calendar-toolbar
          :title="header.title"
          :subtitle="header.subtitle"
          :view="header.view"
          :views="views"
          :can-create="writableCalendars.length > 0"
          :syncing="syncing || loadingCount > 0"
          :failing="failing"
          :last-sync="lastSync"
          @prev="navigate('prev')"
          @next="navigate('next')"
          @today="navigate('today')"
          @view="navigate('view', $event)"
          @create="openNew()"
          @refresh="refreshNow()"
        />
        <div ref="calendarEl" class="ext:flex-1 ext:min-h-0" />
      </section>
    </div>

    <!-- hidden (not closed) while the delete confirmation is shown, to avoid stacked dialogs -->
    <event-editor
      v-if="editor && !confirmingDelete"
      :key="editor.key"
      :event="editor.event"
      :initial="editor.initial"
      :calendars="writableCalendars"
      :read-only="editor.readOnly"
      :modified-occurrence="editor.modifiedOccurrence"
      :saving="saving"
      :me-id="meId"
      :can-respond="!!editor.event && isMyInvitation(editor.event)"
      @save="saveFromEditor"
      @delete="confirmingDelete = true"
      @respond="respondFromEditor"
      @propose="proposeFromEditor"
      @decide="decideFromEditor"
      @close="editor = null"
    />

    <calendar-create-modal
      v-if="creatingCalendar"
      @created="onCalendarCreated"
      @close="creatingCalendar = false"
    />

    <oc-modal
      v-if="confirmingDelete && editor?.event"
      :title="$gettext('Delete event')"
      :message="
        editor.event.recurring
          ? $gettext('Delete every occurrence of “%{title}”?', { title: editor.event.title })
          : $gettext('Delete “%{title}”?', { title: editor.event.title })
      "
      :button-confirm-text="$gettext('Delete')"
      :is-loading="saving"
      @confirm="deleteFromEditor"
      @cancel="confirmingDelete = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, unref, useTemplateRef, watch } from 'vue'
import { Calendar } from '@fullcalendar/core'
import type {
  CalendarOptions,
  DateSelectArg,
  DatesSetArg,
  EventClickArg,
  EventDropArg,
  EventInput,
  EventSourceInput
} from '@fullcalendar/core'
import type { EventResizeDoneArg } from '@fullcalendar/interaction'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import listPlugin from '@fullcalendar/list'
import interactionPlugin from '@fullcalendar/interaction'
import frLocale from '@fullcalendar/core/locales/fr'
import { useMessages, useRoute, useUserStore } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { CalendarSource, ConflictError, EventDraft, EventInstance, useCaldav } from '../composables/useCaldav'
import { apiErrorMessage, Share, useCalshare } from '../composables/useCalshare'
import { useAutoRefresh } from '../composables/useAutoRefresh'
import { useInvitationsFeed } from '../invitationsFeed'
import { dayHeaderContent, eventContent, eventDidMount, nowIndicatorContent } from '../calendarRender'
import CalendarList from '../components/CalendarList.vue'
import CalendarCreateModal from '../components/CalendarCreateModal.vue'
import CalendarToolbar from '../components/CalendarToolbar.vue'
import EventEditor from '../components/EventEditor.vue'
import FilterTabs from '../components/FilterTabs.vue'
import '../calendar.css'

type Filter = 'all' | 'mine' | 'shared' | 'invitations'

const HIDDEN_KEY = 'calendar.hiddenCalendars'
const VIEW_KEY = 'calendar.view'
const LAST_CALENDAR_KEY = 'calendar.lastCalendar'
const REFRESH_MS = 15_000

const { $gettext, current: currentLanguage } = useGettext()
const { showMessage, showErrorMessage } = useMessages()
const caldav = useCaldav()
const calshare = useCalshare()
// Invitations awaiting an answer, whatever their date: the same list as the top-bar bell.
const feed = useInvitationsFeed()
const userStore = useUserStore()
const route = useRoute()
const calendarEl = useTemplateRef<HTMLElement>('calendarEl')
// Driven imperatively: the @fullcalendar/vue3 wrapper deep-watches its options, which
// overflows the stack inside OpenCloud Web. Plain variable on purpose, never reactive.
let fc: Calendar | null = null

const calendars = ref<CalendarSource[]>([])
const owners = ref<Record<string, string>>({})
const hidden = ref<string[]>(readStorage(HIDDEN_KEY, []))
const filter = ref<Filter>('all')
const search = ref('')
const loadError = ref('')
const loadingCount = ref(0)
const sidebarOpen = ref(false)
const saving = ref(false)
const confirmingDelete = ref(false)
const creatingCalendar = ref(false)
const header = reactive({ title: '', subtitle: '', view: '' })
const editor = ref<{
  key: number
  event: EventInstance | null
  initial: EventDraft
  readOnly: boolean
  /** A recurring occurrence changed on its own: edits apply to it alone */
  modifiedOccurrence: boolean
} | null>(null)

const meId = computed(() => userStore.user?.id ?? '')
const writableCalendars = computed(() => calendars.value.filter((c) => c.writable))
const isNarrow = window.matchMedia('(max-width: 767px)').matches

const views = computed(() => [
  { value: 'dayGridMonth', label: $gettext('Month view') },
  { value: 'timeGridWeek', label: $gettext('Week view') },
  { value: 'timeGridDay', label: $gettext('Day view') },
  { value: 'listWeek', label: $gettext('Agenda view') }
])
const tabs = computed(() => [
  { value: 'all' as Filter, label: $gettext('All events') },
  { value: 'mine' as Filter, label: $gettext('My calendars') },
  { value: 'shared' as Filter, label: $gettext('Shared with me') },
  { value: 'invitations' as Filter, label: $gettext('Invitations'), count: feed.pending.value.length }
])

// --- data: per-calendar cache, refreshed when the calendar's ctag changes -------------

/** Events of the visible range, per calendar href. Not reactive: FullCalendar renders them. */
const cache = new Map<string, { range: string; events: EventInstance[] }>()
const dirty = new Set<string>()
const ctags = new Map<string, string>()
let dragging = false

const eventSources = computed<EventSourceInput[]>(() =>
  calendars.value
    .filter((c) => !hidden.value.includes(c.href))
    .map((calendar) => ({
      id: calendar.href,
      events: (info, success, failure) => {
        const range = `${info.startStr}|${info.endStr}`
        const cached = cache.get(calendar.href)
        if (cached && cached.range === range && !dirty.has(calendar.href)) {
          success(visibleEvents(cached.events, calendar))
          return
        }
        loadingCount.value++
        caldav
          .fetchEvents(calendar, info.start, info.end)
          .then((events) => {
            cache.set(calendar.href, { range, events })
            dirty.delete(calendar.href)
            success(visibleEvents(events, calendar))
          })
          .catch((error) => failure(error))
          .finally(() => loadingCount.value--)
      }
    }))
)

function visibleEvents(events: EventInstance[], calendar: CalendarSource) {
  return events.filter((e) => !isDuplicate(e, calendar) && matchesFilter(e, calendar)).map((e) => toFullCalendar(e, calendar))
}

function matchesFilter(event: EventInstance, calendar: CalendarSource) {
  const mineCalendar = holderOf(calendar.href) === meId.value
  const ok = {
    all: true,
    mine: mineCalendar && !event.invitationFrom,
    shared: !mineCalendar,
    invitations: isMyInvitation(event)
  }[filter.value]
  if (!ok) return false
  const q = normalize(search.value)
  return !q || normalize(`${event.title} ${event.location} ${event.description}`).includes(q)
}

function normalize(text: string) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
function onSearch(query: string) {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    search.value = query
  }, 200)
}
// Filters run on the cache: re-render without network.
watch([filter, search], () => fc?.refetchEvents())

/** Whose calendar this is: me, or the person who shared it with me. */
function holderOf(calendarHref: string) {
  return owners.value[calendarHref] ?? meId.value
}

/**
 * In a calendar shared with me, a guest's copy of an event I organize or am invited to, or the
 * organizer's event I am invited to, duplicates what my own calendar already shows.
 */
function isDuplicate(event: EventInstance, calendar: CalendarSource) {
  if (holderOf(calendar.href) === meId.value) return false
  if (event.invitationFrom) {
    return event.organizer?.id === meId.value || event.guests.some((g) => g.id === meId.value)
  }
  // The organizer's own event, invited to: my copy is in my calendar (an event I organize here has none).
  return event.guests.some((g) => g.id === meId.value)
}

/** My own copy of an invitation: the only one I can answer. */
function isMyInvitation(event: EventInstance) {
  return !!event.invitationFrom && holderOf(event.calendarHref) === meId.value
}

function toFullCalendar(event: EventInstance, calendar: CalendarSource): EventInput {
  // Only the organizer moves an event; guests answer the invitation instead.
  const movable = calendar.writable && !event.recurring && !event.invitationFrom
  const classNames = ['oc-ev']
  const title = event.title || $gettext('(no title)')
  if (event.invitationFrom) {
    const holder = holderOf(calendar.href)
    const response = event.guests.find((g) => g.id === holder)?.response ?? 'pending'
    // status puce before the title, drawn in calendar.css
    classNames.push('oc-ev-invitation', `oc-ev-${response}`)
  } else if (event.guests.length) {
    classNames.push('oc-ev-with-guests')
    if (event.guests.some((g) => g.proposal)) classNames.push('oc-ev-proposal')
  }
  return {
    id: event.key,
    title,
    start: event.start,
    end: event.end ?? undefined,
    allDay: event.allDay,
    classNames,
    startEditable: movable,
    durationEditable: movable,
    extendedProps: { instance: event, location: event.location, color: event.color ?? calendar.color }
  }
}

// --- FullCalendar -------------------------------------------------------------------

function baseOptions(): CalendarOptions {
  return {
    plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
    locales: [frLocale],
    locale: unref(currentLanguage).startsWith('fr') ? 'fr' : 'en',
    initialView: readStorage(VIEW_KEY, isNarrow ? 'listWeek' : 'timeGridWeek'),
    // ?date=YYYY-MM-DD (e.g. "Open in the calendar" from an invitation)
    initialDate: /^\d{4}-\d{2}-\d{2}$/.test(String(unref(route).query.date ?? ''))
      ? String(unref(route).query.date)
      : undefined,
    headerToolbar: false,
    height: '100%',
    firstDay: 1,
    nowIndicator: true,
    dayMaxEvents: true,
    // Events at the same time sit side by side: overlapping, the later one hid the other's title.
    slotEventOverlap: false,
    scrollTime: '08:00:00',
    slotLabelFormat: { hour: 'numeric', minute: '2-digit', omitZeroMinute: true },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit' },
    selectable: false,
    selectMirror: true,
    editable: true,
    dayHeaderContent,
    eventContent,
    eventDidMount,
    nowIndicatorContent,
    select: onSelect,
    eventClick: onEventClick,
    eventDrop: onEventMoved,
    eventResize: onEventMoved,
    eventDragStart: () => (dragging = true),
    eventDragStop: () => (dragging = false),
    eventResizeStart: () => (dragging = true),
    eventResizeStop: () => (dragging = false),
    datesSet: onDatesSet,
    eventSourceFailure: (error) => showErrorMessage({ title: $gettext('Could not load events'), errors: [error] })
  }
}

function onDatesSet(info: DatesSetArg) {
  writeStorage(VIEW_KEY, info.view.type)
  const api = info.view.calendar
  const lastDay = new Date(info.view.currentEnd.getTime() - 1)
  const month = api.formatDate(api.getDate(), { month: 'long', year: 'numeric' })
  header.title = month.charAt(0).toUpperCase() + month.slice(1)
  header.subtitle =
    info.view.type === 'timeGridDay'
      ? api.formatDate(info.view.currentStart, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : api.formatRange(info.view.currentStart, lastDay, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          separator: ' – '
        })
  header.view = info.view.type
}

function navigate(action: 'prev' | 'next' | 'today' | 'view', view?: string) {
  if (!fc) return
  if (action === 'view') fc.changeView(view!)
  else fc[action]()
}

function syncSources(sources: EventSourceInput[]) {
  if (!fc) return
  fc.batchRendering(() => {
    fc!.getEventSources().forEach((source) => source.remove())
    sources.forEach((source) => fc!.addEventSource(source))
  })
}

watch(eventSources, syncSources)
watch(writableCalendars, (list) => fc?.setOption('selectable', list.length > 0))
watch(
  () => unref(currentLanguage),
  (lang) => fc?.setOption('locale', lang.startsWith('fr') ? 'fr' : 'en')
)

// --- calendars & auto refresh ---------------------------------------------------------

/** What changes the sources (and requires re-adding them); ctags are tracked separately. */
function signature(list: CalendarSource[]) {
  return list.map((c) => `${c.href}|${c.name}|${c.color}|${c.writable}`).sort().join('\n')
}

async function loadCalendars(list?: CalendarSource[]) {
  try {
    const [found, incoming] = await Promise.all([
      list ? Promise.resolve(list) : caldav.listCalendars(),
      // Sharing metadata is optional: the calendar still works if the sidecar is down.
      calshare.listIncoming().catch((): Share[] => [])
    ])
    const ownersByHref: Record<string, string> = {}
    for (const share of incoming) {
      const cal = found.find((c) => c.id === share.mount)
      if (cal) ownersByHref[cal.href] = share.owner
    }
    owners.value = ownersByHref
    found.forEach((c) => ctags.set(c.href, c.ctag))
    // Own calendars first, then shared ones.
    calendars.value = [...found].sort((a, b) => Number(!!ownersByHref[a.href]) - Number(!!ownersByHref[b.href]))
    loadError.value = ''
  } catch (error) {
    loadError.value = (error as Error).message
    throw error
  }
}

/** One PROPFIND: reload only the calendars whose content changed (ctag). */
async function checkForChanges() {
  const list = await caldav.listCalendars()
  if (signature(list) !== signature(calendars.value)) {
    list.forEach((c) => dirty.add(c.href))
    await loadCalendars(list)
    return
  }
  for (const calendar of list) {
    if (ctags.get(calendar.href) !== calendar.ctag) {
      ctags.set(calendar.href, calendar.ctag)
      dirty.add(calendar.href)
      fc?.getEventSourceById(calendar.href)?.refetch()
    }
  }
}

// Answers given from the top-bar bell change the guest's copies: reload them.
watch(feed.version, () => refetch())

const { lastSync, syncing, failing, refreshNow } = useAutoRefresh(checkForChanges, {
  intervalMs: REFRESH_MS,
  paused: () => dragging
})

async function onCalendarCreated() {
  creatingCalendar.value = false
  await refreshNow()
}

function toggleCalendar(href: string) {
  hidden.value = hidden.value.includes(href) ? hidden.value.filter((h) => h !== href) : [...hidden.value, href]
  writeStorage(HIDDEN_KEY, hidden.value)
}

// --- editing ------------------------------------------------------------------------

/** For new events: the calendar used last, else the default one (def-calendar), else any own calendar. */
function defaultCalendarHref() {
  const writable = writableCalendars.value
  const own = writable.filter((c) => !owners.value[c.href])
  const last = readStorage<string>(LAST_CALENDAR_KEY, '')
  return (
    writable.find((c) => c.href === last) ??
    own.find((c) => c.id === 'def-calendar') ??
    own[0] ??
    writable[0]
  )?.href ?? ''
}

function openEditor(event: EventInstance | null, initial: EventDraft, readOnly = false) {
  confirmingDelete.value = false
  const key = Date.now()
  editor.value = { key, event, initial, readOnly, modifiedOccurrence: false }
  if (event?.recurring) {
    caldav
      .isModified(event)
      .then((modified) => {
        if (editor.value?.key === key) editor.value.modifiedOccurrence = modified
      })
      .catch(() => {})
  }
}

function emptyDraft(start: Date, end: Date, allDay: boolean): EventDraft {
  return {
    calendarHref: defaultCalendarHref(),
    title: '',
    allDay,
    start,
    end,
    location: '',
    description: '',
    guests: [],
    color: null
  }
}

function draftOf(instance: EventInstance, start: Date, end: Date, allDay: boolean): EventDraft {
  return {
    calendarHref: instance.calendarHref,
    title: instance.title,
    allDay,
    start,
    end,
    location: instance.location,
    description: instance.description,
    guests: instance.guests,
    color: instance.color
  }
}

function openNew() {
  const start = new Date()
  start.setHours(start.getHours() + 1, 0, 0, 0)
  openEditor(null, emptyDraft(start, new Date(start.getTime() + 3600_000), false))
}

function onSelect(info: DateSelectArg) {
  info.view.calendar.unselect()
  let end = info.end
  // A single click in the week/day grid selects one slot (30 min); default to one hour.
  if (!info.allDay && end.getTime() - info.start.getTime() <= 1800_000) {
    end = new Date(info.start.getTime() + 3600_000)
  }
  openEditor(null, emptyDraft(info.start, end, info.allDay))
}

function endOf(start: Date, end: Date | null, allDay: boolean) {
  return end ?? new Date(start.getTime() + (allDay ? 86400_000 : 3600_000))
}

function onEventClick(info: EventClickArg) {
  const instance = info.event.extendedProps.instance as EventInstance
  const calendar = calendars.value.find((c) => c.href === instance.calendarHref)
  const start = info.event.start!
  openEditor(
    instance,
    draftOf(instance, start, endOf(start, info.event.end, info.event.allDay), info.event.allDay),
    !calendar?.writable || !!instance.invitationFrom
  )
}

async function onEventMoved(info: EventDropArg | EventResizeDoneArg) {
  const instance = info.event.extendedProps.instance as EventInstance
  const start = info.event.start!
  const oldStart = info.oldEvent.start!
  try {
    // Only the times change: the texts stay as stored, even if they changed elsewhere since the last refresh.
    await caldav.updateEvent(
      instance,
      draftOf(instance, start, endOf(start, info.event.end, info.event.allDay), info.event.allDay),
      draftOf(instance, oldStart, endOf(oldStart, info.oldEvent.end, info.oldEvent.allDay), info.oldEvent.allDay)
    )
    refetch()
  } catch (error) {
    info.revert()
    reportError(error, $gettext('Could not move the event'))
  }
}

async function saveFromEditor(draft: EventDraft) {
  const current = editor.value
  if (!current) return
  saving.value = true
  try {
    const href = current.event
      ? await caldav.updateEvent(current.event, draft, current.initial)
      : await caldav.createEvent(draft)
    writeStorage(LAST_CALENDAR_KEY, draft.calendarHref)
    const before = current.initial.guests.map((g) => g.id).sort().join()
    const after = draft.guests.map((g) => g.id).sort().join()
    if (before !== after) {
      // The sidecar writes ORGANIZER/ATTENDEE and delivers the invitations.
      const { calendar, file } = splitHref(href)
      await calshare.setGuests(calendar, file, draft.guests.map((g) => g.id))
    }
    editor.value = null
    showMessage({
      title: current.event ? $gettext('Event updated') : $gettext('Event created'),
      desc: after && before !== after ? $gettext('Invitations are on their way to the guests.') : undefined
    })
    refetch()
  } catch (error) {
    reportError(error, $gettext('Could not save the event'))
  } finally {
    saving.value = false
  }
}

async function respondFromEditor(response: 'accepted' | 'tentative' | 'declined') {
  const event = editor.value?.event
  if (!event) return
  saving.value = true
  try {
    const { calendar, file } = splitHref(event.href)
    await calshare.answerInvitation(calendar, file, response)
    feed.refresh()
    editor.value = null
    showMessage({
      title: {
        accepted: $gettext('You accepted the invitation'),
        tentative: $gettext('You answered maybe'),
        declined: $gettext('You declined the invitation')
      }[response]
    })
    refetch()
  } catch (error) {
    reportError(error, $gettext('Could not send your answer'))
  } finally {
    saving.value = false
  }
}

async function proposeFromEditor(proposal: { start: string; end: string }) {
  const event = editor.value?.event
  if (!event) return
  saving.value = true
  try {
    const { calendar, file } = splitHref(event.href)
    await calshare.propose(calendar, file, proposal.start, proposal.end)
    editor.value = null
    showMessage({ title: $gettext('Your proposal was sent to the organizer') })
    refetch()
  } catch (error) {
    showErrorMessage({ title: $gettext('Could not send your proposal'), desc: apiErrorMessage(error), errors: [error as Error] })
  } finally {
    saving.value = false
  }
}

async function decideFromEditor(guest: string, accept: boolean) {
  const event = editor.value?.event
  if (!event) return
  saving.value = true
  try {
    const { calendar, file } = splitHref(event.href)
    await calshare.decideProposal(calendar, file, guest, accept)
    editor.value = null
    showMessage({
      title: accept ? $gettext('The event was moved to the proposed time') : $gettext('Proposal declined')
    })
    refetch()
  } catch (error) {
    reportError(error, $gettext('Could not answer the proposal'))
  } finally {
    saving.value = false
  }
}

/** /caldav/<user>/<calendar>/<file> -> calendar id (or share mount) and file name */
function splitHref(href: string) {
  const [, , , calendar, file] = href.split('/')
  return { calendar, file }
}

async function deleteFromEditor() {
  const event = editor.value?.event
  if (!event) return
  saving.value = true
  try {
    await caldav.deleteEvent(event.href, event.etag)
    editor.value = null
    confirmingDelete.value = false
    showMessage({ title: $gettext('Event deleted') })
    refetch()
  } catch (error) {
    reportError(error, $gettext('Could not delete the event'))
  } finally {
    saving.value = false
  }
}

function reportError(error: unknown, title: string) {
  if (error instanceof ConflictError) {
    showErrorMessage({
      title,
      desc: $gettext('This event was changed somewhere else in the meantime. The calendar has been reloaded.'),
      errors: [error]
    })
    refetch()
    return
  }
  showErrorMessage({ title, errors: [error as Error] })
}

/** After our own changes: everything may have moved (invitations land in other calendars). */
function refetch() {
  calendars.value.forEach((c) => dirty.add(c.href))
  fc?.refetchEvents()
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable (private mode…): preferences just aren't remembered
  }
}

onMounted(() => {
  fc = new Calendar(calendarEl.value!, baseOptions())
  fc.render()
  loadCalendars().catch(() => {})
})

onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  fc?.destroy()
  fc = null
})
</script>
