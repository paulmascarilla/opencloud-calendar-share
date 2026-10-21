<template>
  <section v-if="!disabled" class="availability ext:flex ext:flex-col ext:gap-2" :aria-label="$gettext('Availability')">
    <div class="ext:flex ext:items-center ext:gap-2">
      <h3 class="ext:m-0 ext:text-sm ext:font-semibold ext:flex-1">
        {{ $gettext('Availability') }}
        <oc-spinner v-if="loading" size="xsmall" class="ext:ml-1 ext:align-middle" :aria-label="$gettext('Checking availability')" />
      </h3>
      <div class="day-nav ext:inline-flex ext:items-center ext:rounded-lg ext:border ext:border-role-outline-variant ext:overflow-hidden">
        <oc-button appearance="raw" size="small" :aria-label="$gettext('Previous day')" @click="shiftDay(-1)">
          <oc-icon name="arrow-left-s" size="small" />
        </oc-button>
        <span class="ext:px-2 ext:text-xs ext:font-medium ext:whitespace-nowrap" aria-live="polite">{{ dayLabel }}</span>
        <oc-button appearance="raw" size="small" :aria-label="$gettext('Next day')" @click="shiftDay(1)">
          <oc-icon name="arrow-right-s" size="small" />
        </oc-button>
      </div>
    </div>

    <div class="timeline" :class="{ 'is-loading': loading && !loadedOnce }">
      <!-- hour axis -->
      <div class="row axis" aria-hidden="true">
        <span class="who" />
        <div class="track">
          <span
            v-for="tick in ticks"
            :key="tick.hour"
            class="tick-label"
            :class="{ minor: tick.minor }"
            :style="{ left: `${tick.left}%` }"
            >{{ tick.label }}</span
          >
        </div>
      </div>

      <div class="rows">
        <div
          v-for="row in rows"
          :key="row.id"
          class="row"
          :class="{ pending: row.pending }"
          :aria-label="row.summary"
          role="group"
        >
          <span class="who ext:flex ext:items-center ext:gap-1.5 ext:min-w-0">
            <oc-avatar :user-name="row.name" :width="20" />
            <span class="ext:truncate ext:text-xs" :title="row.name">{{ row.label }}</span>
          </span>
          <div
            class="track"
            :class="{ clickable: canMove, unknown: !row.calendar || row.failed }"
            @click="onTrackClick"
            @mousemove="onTrackHover"
            @mouseleave="hover = null"
          >
            <span v-for="tick in ticks" :key="tick.hour" class="gridline" :style="{ left: `${tick.left}%` }" />
            <span v-if="row.failed" class="unknown-label">{{ $gettext('Could not be checked') }}</span>
            <span v-else-if="!row.calendar" class="unknown-label">{{ $gettext('No calendar') }}</span>
            <span
              v-for="(seg, i) in row.segments"
              :key="i"
              class="seg"
              :class="[seg.status, { conflict: seg.conflict, 'all-day': seg.allDay }]"
              :style="{ left: `${seg.left}%`, width: `${seg.width}%` }"
              :title="seg.title"
            />
          </div>
        </div>

        <!-- the event across every row, and where a click would move it -->
        <div v-if="band || hover" class="band-layer" aria-hidden="true">
          <span class="who" />
          <div class="band-track">
            <span
              v-if="band"
              class="band"
              :class="{ clash: conflicts.busy.length }"
              :style="{ left: `${band.left}%`, width: `${band.width}%` }"
            />
            <span v-if="hover" class="ghost" :style="{ left: `${hover.left}%`, width: `${hover.width}%` }" />
          </div>
        </div>
      </div>
    </div>

    <!-- verdict + suggestion -->
    <div class="verdict ext:flex ext:flex-wrap ext:items-center ext:gap-x-3 ext:gap-y-1 ext:text-sm" role="status">
      <template v-if="failed">
        <span class="ext:text-role-on-surface-variant">{{ $gettext('Availability could not be loaded.') }}</span>
        <oc-button appearance="raw" size="small" @click="load(true)">{{ $gettext('Retry') }}</oc-button>
      </template>
      <span v-else-if="pending" class="ext:text-role-on-surface-variant">{{ $gettext('Checking availability…') }}</span>
      <template v-else-if="loadedOnce">
        <span v-if="conflicts.busy.length" class="state clash ext:inline-flex ext:items-center ext:gap-1">
          <oc-icon name="error-warning" size="small" />{{ busyText }}
        </span>
        <span v-else-if="conflicts.tentative.length" class="state maybe ext:inline-flex ext:items-center ext:gap-1">
          <oc-icon name="question" size="small" />{{ tentativeText }}
        </span>
        <span v-else class="state free ext:inline-flex ext:items-center ext:gap-1">
          <oc-icon name="checkbox-circle" size="small" />{{ $gettext('Everyone is available') }}
        </span>
        <oc-button
          v-if="suggestion"
          appearance="outline"
          size="small"
          class="suggest"
          :disabled="moveDisabled"
          @click="emit('move', suggestion)"
        >
          <oc-icon name="calendar-check" size="small" />
          {{ $gettext('Next time everyone is free: %{when}', { when: formatSlot(suggestion) }) }}
        </oc-button>
        <span v-else-if="searched && (conflicts.busy.length || conflicts.tentative.length)" class="ext:text-xs ext:text-role-on-surface-variant">
          {{ $gettext('No common free time in the next two weeks.') }}
        </span>
      </template>
    </div>

  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useGettext } from 'vue3-gettext'
import { isFreeBusyDisabled, useCalshare } from '../composables/useCalshare'
import { addDays, Interval, intervals, nextFreeSlot, startOfDay, statusBetween } from '../availability'
import type { Person } from '../ical'

const props = defineProps<{
  meId: string
  /** Guests of the event (the organizer, me, is added first) */
  guests: Person[]
  start: Date | null
  end: Date | null
  allDay: boolean
  /** UID of the event being edited, so it does not conflict with itself */
  except?: string
  /** Times cannot be changed (recurring event) */
  moveDisabled?: boolean
}>()
const emit = defineEmits<{ (e: 'move', start: Date): void }>()

const { $gettext, current } = useGettext()
const calshare = useCalshare()

const HORIZON_DAYS = 14
const MAX_PEOPLE = 20
const QUARTER = 15 * 60_000

const day = ref(startOfDay(props.start ?? new Date()))
const people = computed(() => [
  { id: props.meId, name: $gettext('You') },
  ...props.guests.filter((g) => g.id !== props.meId)
].slice(0, MAX_PEOPLE))

// --- data ------------------------------------------------------------------------------

const busy = ref<Record<string, { calendar: boolean; failed: boolean; list: Interval[] }>>({})
const loaded = ref<{ from: number; to: number; users: string } | null>(null)
const loading = ref(false)
const loadedOnce = ref(false)
const failed = ref(false)
const disabled = ref(false)
let ticket = 0
let debounce: ReturnType<typeof setTimeout> | undefined

const userKey = computed(() => people.value.map((p) => p.id).sort().join(','))

async function load(force = false) {
  const from = startOfDay(new Date(Math.min(day.value.getTime(), (props.start ?? day.value).getTime())))
  const to = addDays(from, HORIZON_DAYS + 1)
  const range = loaded.value
  if (
    !force &&
    range &&
    range.users === userKey.value &&
    range.from <= day.value.getTime() &&
    addDays(day.value, 1).getTime() <= range.to &&
    (!props.start || (range.from <= props.start.getTime() && props.start.getTime() < range.to))
  ) {
    return
  }
  const mine = ++ticket
  loading.value = true
  try {
    const answer = await calshare.freeBusy(
      people.value.map((p) => p.id),
      from,
      to,
      { except: props.except }
    )
    if (mine !== ticket) return
    busy.value = Object.fromEntries(
      answer.map((a) => [a.id, { calendar: a.calendar, failed: !!a.error, list: intervals(a.busy) }])
    )
    loaded.value = { from: from.getTime(), to: to.getTime(), users: userKey.value }
    loadedOnce.value = true
    failed.value = false
  } catch (error) {
    if (mine !== ticket) return
    if (isFreeBusyDisabled(error)) disabled.value = true
    else failed.value = true
  } finally {
    if (mine === ticket) loading.value = false
  }
}

function scheduleLoad() {
  clearTimeout(debounce)
  debounce = setTimeout(() => load(), 250)
}
watch([userKey, day], scheduleLoad, { immediate: true })
// Follow the event when its date changes (typed in the editor, or a suggestion taken).
watch(
  () => props.start?.getTime(),
  () => {
    if (props.start) day.value = startOfDay(props.start)
  }
)
onBeforeUnmount(() => clearTimeout(debounce))

// --- layout ------------------------------------------------------------------------------

/** Hours shown: 7:00–21:00, widened to show the event when it falls outside. */
const window_ = computed(() => {
  let first = 7
  let last = 21
  const dayStart = day.value.getTime()
  const dayEnd = addDays(day.value, 1).getTime()
  if (props.start && props.end && !props.allDay && props.start.getTime() < dayEnd && props.end.getTime() > dayStart) {
    const s = Math.max(props.start.getTime(), dayStart)
    const e = Math.min(props.end.getTime(), dayEnd)
    first = Math.min(first, Math.floor((s - dayStart) / 3_600_000))
    last = Math.max(last, Math.ceil((e - dayStart) / 3_600_000))
  }
  const from = new Date(day.value.getFullYear(), day.value.getMonth(), day.value.getDate(), first).getTime()
  const to = new Date(day.value.getFullYear(), day.value.getMonth(), day.value.getDate(), last).getTime()
  return { from, to, first, last }
})

function percent(t: number) {
  const { from, to } = window_.value
  return ((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100
}

const hourFormat = computed(() => new Intl.DateTimeFormat(current, { hour: 'numeric' }))
const timeFormat = computed(() => new Intl.DateTimeFormat(current, { hour: '2-digit', minute: '2-digit' }))

const ticks = computed(() => {
  const { first, last } = window_.value
  const out = []
  for (let h = first; h <= last; h++) {
    if (h % 2) continue
    const at = new Date(day.value.getFullYear(), day.value.getMonth(), day.value.getDate(), h)
    out.push({ hour: h, left: percent(at.getTime()), label: hourFormat.value.format(at), minor: h % 4 !== 0 })
  }
  return out
})

const eventRange = computed(() =>
  props.start && props.end && props.end > props.start ? { start: props.start.getTime(), end: props.end.getTime() } : null
)

const band = computed(() => {
  const ev = eventRange.value
  const { from, to } = window_.value
  if (!ev || ev.end <= from || ev.start >= to) return null
  const left = percent(ev.start)
  return { left, width: Math.max(percent(ev.end) - left, 0.8) }
})

const rows = computed(() => {
  const { from, to } = window_.value
  const ev = eventRange.value
  return people.value.map((person) => {
    const data = busy.value[person.id]
    const list = data?.list ?? []
    const segments = list
      .filter((i) => i.end > from && i.start < to)
      .map((i) => {
        const left = percent(i.start)
        return {
          left,
          width: Math.max(percent(i.end) - left, 0.6),
          status: i.status,
          allDay: i.allDay,
          conflict: !!ev && i.start < ev.end && i.end > ev.start,
          title: describe(i)
        }
      })
      // all-day first, so the timed blocks are drawn above them
      .sort((a, b) => Number(b.allDay) - Number(a.allDay))
    const label = person.id === props.meId ? $gettext('You') : person.name
    const summary = !data
      ? label
      : data.failed
        ? `${label}: ${$gettext('Could not be checked')}`
        : !data.calendar
          ? `${label}: ${$gettext('No calendar')}`
          : segments.length
            ? `${label}: ${segments.map((s) => s.title).join(', ')}`
            : `${label}: ${$gettext('Free all day')}`
    return {
      id: person.id,
      name: person.name,
      label,
      calendar: data?.calendar ?? true,
      failed: !!data?.failed,
      segments,
      summary,
      pending: !data
    }
  })
})

function describe(i: Interval) {
  const status = i.title || (i.status === 'busy' ? $gettext('Busy') : $gettext('Maybe'))
  if (i.allDay) return `${status} · ${$gettext('All day')}`
  return `${status} · ${timeFormat.value.format(i.start)} – ${timeFormat.value.format(i.end)}`
}

// --- verdict ------------------------------------------------------------------------------

/** Someone was just added and their times are not here yet: no verdict until they are. */
const pending = computed(() => people.value.some((p) => !busy.value[p.id]))

const conflicts = computed(() => {
  const ev = eventRange.value
  const out = { busy: [] as string[], tentative: [] as string[] }
  if (!ev) return out
  for (const person of people.value) {
    const data = busy.value[person.id]
    if (!data?.calendar) continue
    const status = statusBetween(data.list, ev.start, ev.end)
    const name = person.id === props.meId ? $gettext('You') : person.name
    if (status) out[status].push(name)
  }
  return out
})

const busyText = computed(() => {
  const names = conflicts.value.busy
  if (names.length === 1 && names[0] === $gettext('You')) return $gettext('You are busy at this time')
  return names.length === 1
    ? $gettext('%{name} is busy at this time', { name: names[0] })
    : $gettext('%{names} are busy at this time', { names: list(names) })
})
const tentativeText = computed(() => {
  const names = conflicts.value.tentative
  if (names.length === 1 && names[0] === $gettext('You')) return $gettext('You might be busy at this time')
  return names.length === 1
    ? $gettext('%{name} might be busy at this time', { name: names[0] })
    : $gettext('%{names} might be busy at this time', { names: list(names) })
})

function list(names: string[]) {
  try {
    return new Intl.ListFormat(current, { style: 'long', type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

/** Whether a suggestion was looked for (timed events with a conflict, data loaded). */
const searched = computed(
  () => !props.allDay && !!eventRange.value && !!loaded.value && !props.moveDisabled
)

const suggestion = computed(() => {
  const ev = eventRange.value
  const range = loaded.value
  if (!searched.value || !ev || !range || pending.value) return null
  if (!conflicts.value.busy.length && !conflicts.value.tentative.length) return null
  const lists = people.value.map((p) => busy.value[p.id]).filter((d) => d?.calendar).map((d) => d!.list)
  const startDay = new Date(ev.start).getDay()
  return nextFreeSlot(lists, new Date(ev.start), ev.end - ev.start, {
    weekends: startDay === 0 || startDay === 6,
    horizon: Math.max(0, (range.to - ev.start) / 86_400_000)
  })
})

function formatSlot(date: Date) {
  const sameDay = startOfDay(date).getTime() === startOfDay(props.start ?? date).getTime()
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
  return new Intl.DateTimeFormat(current, options).format(date)
}

const dayLabel = computed(() =>
  new Intl.DateTimeFormat(current, { weekday: 'short', day: 'numeric', month: 'short' }).format(day.value)
)

function shiftDay(delta: number) {
  day.value = addDays(day.value, delta)
}

// --- click on the timeline: move the event there --------------------------------------

const canMove = computed(() => !props.allDay && !props.moveDisabled && !!eventRange.value)
const hover = ref<{ left: number; width: number } | null>(null)

function timeAt(event: MouseEvent) {
  const track = event.currentTarget as HTMLElement
  const rect = track.getBoundingClientRect()
  const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
  const { from, to } = window_.value
  const duration = eventRange.value ? eventRange.value.end - eventRange.value.start : 3_600_000
  // Centre the event on the pointer, on a quarter hour, inside the window.
  const raw = from + ratio * (to - from) - duration / 2
  return Math.min(Math.max(Math.round(raw / QUARTER) * QUARTER, from), to - Math.min(duration, to - from))
}

function onTrackHover(event: MouseEvent) {
  if (!canMove.value) return
  const start = timeAt(event)
  const duration = eventRange.value!.end - eventRange.value!.start
  const left = percent(start)
  hover.value = { left, width: Math.max(percent(start + duration) - left, 0.8) }
}

function onTrackClick(event: MouseEvent) {
  if (!canMove.value) return
  hover.value = null
  emit('move', new Date(timeAt(event)))
}
</script>

<style scoped>
.availability {
  --row-h: 1.75rem;
  --who-w: 6.5rem;
  --busy: color-mix(in srgb, var(--oc-role-on-surface-variant) 62%, var(--oc-role-surface));
  --tentative: color-mix(in srgb, var(--oc-role-on-surface-variant) 45%, transparent);
  --clash: var(--oc-role-error);
  --event: var(--oc-role-primary);
}
.timeline {
  container-type: inline-size;
  border: 1px solid var(--oc-role-outline-variant);
  border-radius: 0.5rem;
  padding: 0.35rem 0.5rem 0.4rem;
  background: var(--oc-role-surface);
}
.row,
.band-layer {
  display: grid;
  grid-template-columns: var(--who-w) 1fr;
  align-items: center;
  column-gap: 0.5rem;
}
.rows {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.who {
  height: var(--row-h);
}
.axis .who,
.axis .track {
  height: 1.1rem;
}
.track {
  position: relative;
  height: var(--row-h);
  border-radius: 0.3rem;
  background: var(--oc-role-surface-container-low);
  overflow: hidden;
}
.axis .track {
  background: transparent;
  overflow: visible;
}
.track.clickable {
  cursor: pointer;
}
.track.unknown {
  background: repeating-linear-gradient(
    -45deg,
    transparent 0 5px,
    color-mix(in srgb, var(--oc-role-outline-variant) 35%, transparent) 5px 6px
  );
}
.tick-label {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  font-size: 0.68rem;
  line-height: 1;
  color: var(--oc-role-on-surface-variant);
  white-space: nowrap;
}
.tick-label:first-child {
  transform: none;
}
@container (max-width: 26rem) {
  .tick-label.minor {
    display: none;
  }
  .availability {
    --who-w: 4.5rem;
  }
}
.gridline {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--oc-role-outline-variant) 60%, transparent);
}
.unknown-label {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 0.7rem;
  font-style: italic;
  color: var(--oc-role-on-surface-variant);
}
.seg {
  position: absolute;
  top: 0.3rem;
  bottom: 0.3rem;
  border-radius: 0.2rem;
  background: var(--busy);
  transition: background-color 120ms ease;
}
.seg.all-day {
  top: 0.15rem;
  bottom: 0.15rem;
  opacity: 0.45;
}
.seg.tentative {
  background: repeating-linear-gradient(-45deg, var(--tentative) 0 3px, transparent 3px 6px);
  box-shadow: inset 0 0 0 1px var(--tentative);
}
.seg.conflict.busy {
  background: var(--clash);
}
.seg.conflict.tentative {
  --tentative: color-mix(in srgb, var(--clash) 70%, transparent);
}
.band-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.band-track {
  position: relative;
  height: 100%;
}
.band,
.ghost {
  position: absolute;
  top: -0.15rem;
  bottom: -0.15rem;
  border-radius: 0.35rem;
}
.band {
  background: color-mix(in srgb, var(--event) 14%, transparent);
  box-shadow:
    inset 0 0 0 1.5px var(--event),
    0 0 0 2px color-mix(in srgb, var(--oc-role-surface) 70%, transparent);
}
.band.clash {
  background: color-mix(in srgb, var(--clash) 8%, transparent);
  box-shadow:
    inset 0 0 0 1.5px var(--clash),
    0 0 0 2px color-mix(in srgb, var(--oc-role-surface) 70%, transparent);
}
.ghost {
  border: 1.5px dashed color-mix(in srgb, var(--event) 70%, transparent);
}
.is-loading .rows .track,
.row.pending .track {
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.55;
  }
}
@media (prefers-reduced-motion: reduce) {
  .is-loading .rows .track,
  .row.pending .track {
    animation: none;
  }
  .seg {
    transition: none;
  }
}
.state.free {
  color: var(--oc-role-primary);
}
.state.maybe {
  color: var(--oc-role-on-surface-variant);
}
.state.clash {
  color: var(--clash);
  font-weight: 500;
}
.day-nav :deep(.oc-button) {
  border-radius: 0;
  padding: 0.2rem 0.35rem;
  color: var(--oc-role-on-surface-variant);
}
.day-nav :deep(.oc-button:hover),
.day-nav :deep(.oc-button:focus-visible) {
  background: var(--oc-role-surface-container-high);
  color: var(--oc-role-on-surface);
}
.day-nav :deep(.oc-button:focus:not(:focus-visible):not(:hover)) {
  background: transparent;
  color: var(--oc-role-on-surface-variant);
}
</style>
