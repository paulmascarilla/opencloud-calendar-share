<template>
  <oc-modal
    :title="modalTitle"
    :button-confirm-text="$gettext('Save')"
    :button-confirm-disabled="!canSave"
    :hide-confirm-button="readOnly"
    :is-loading="saving"
    focus-trap-initial="#event-title"
    @confirm="save"
    @cancel="emit('close')"
  >
    <template #content>
      <form class="ext:flex ext:flex-col ext:gap-3" @submit.prevent="save">
        <div v-if="invitation" class="rsvp ext:flex ext:flex-col ext:gap-2 ext:p-3 ext:rounded">
          <span class="ext:text-sm">
            {{ $gettext('%{name} invited you. Will you attend?', { name: event?.organizer?.name ?? '' }) }}
          </span>
          <div class="ext:flex ext:flex-wrap ext:gap-2" role="group" :aria-label="$gettext('Your answer')">
            <oc-button
              v-for="option in rsvpOptions"
              :key="option.value"
              :appearance="myResponse === option.value ? 'filled' : 'outline'"
              size="small"
              :aria-pressed="myResponse === option.value"
              :disabled="saving"
              @click="emit('respond', option.value)"
            >
              <oc-icon :name="option.icon" size="small" />
              {{ option.label }}
            </oc-button>
            <oc-button
              v-if="!event?.recurring && !proposing"
              appearance="raw"
              size="small"
              :disabled="saving"
              @click="proposing = true"
            >
              <oc-icon name="calendar-event" size="small" />
              {{ $gettext('Propose another time') }}
            </oc-button>
          </div>
          <propose-time
            v-if="proposing"
            :start="initial.start"
            :end="initial.end"
            :all-day="initial.allDay"
            :sending="saving"
            @submit="emit('propose', $event)"
            @cancel="proposing = false"
          />
        </div>

        <oc-notification-message
          v-if="event?.recurring"
          status="passive"
          :title="$gettext('Recurring event')"
          :message="
            modifiedOccurrence
              ? $gettext(
                  'This occurrence was changed on its own: changes apply to it only. Dates can only be changed in a calendar app.'
                )
              : $gettext('Changes apply to the whole series. Dates can only be changed in a calendar app.')
          "
        />

        <oc-text-input
          id="event-title"
          v-model="title"
          :label="$gettext('Title')"
          :disabled="readOnly"
          :required-mark="true"
        />

        <oc-select
          v-if="!readOnly"
          v-model="calendar"
          :options="calendars"
          option-label="name"
          :clearable="false"
          :searchable="false"
          :label="$gettext('Calendar')"
        >
          <template #option="option">
            <span class="ext:inline-flex ext:items-center ext:gap-2">
              <span class="dot" :style="{ backgroundColor: option.color }" />{{ option.name }}
            </span>
          </template>
        </oc-select>

        <oc-checkbox
          v-model="allDay"
          :label="$gettext('All day')"
          :disabled="readOnly || timesLocked"
        />

        <div class="ext:grid ext:grid-cols-1 ext:sm:grid-cols-2 ext:gap-3">
          <label class="field">
            <span>{{ $gettext('Start') }}</span>
            <input
              :key="allDay ? 'start-date' : 'start-time'"
              v-model="startInput"
              :type="allDay ? 'date' : 'datetime-local'"
              :disabled="readOnly || timesLocked"
              required
            />
          </label>
          <label class="field">
            <span>{{ $gettext('End') }}</span>
            <input
              :key="allDay ? 'end-date' : 'end-time'"
              v-model="endInput"
              :type="allDay ? 'date' : 'datetime-local'"
              :disabled="readOnly || timesLocked"
              required
            />
          </label>
        </div>
        <p v-if="rangeInvalid" class="ext:m-0 ext:text-sm ext:text-role-error">
          {{ $gettext('The end must be after the start.') }}
        </p>

        <div v-if="!readOnly" class="ext:flex ext:flex-col ext:gap-1">
          <div class="ext:flex ext:flex-wrap ext:items-center ext:gap-x-6 ext:gap-y-2">
            <div class="ext:inline-flex ext:items-center ext:gap-2">
              <span class="ext:text-sm" aria-hidden="true">{{ $gettext('Show me as') }}</span>
              <filter-tabs
                :model-value="busy ? 'busy' : 'free'"
                :tabs="showAsOptions"
                :label="$gettext('Show me as')"
                @update:model-value="setBusy($event === 'busy')"
              />
            </div>
            <div class="ext:inline-flex ext:items-center ext:gap-2">
              <span class="ext:text-sm" aria-hidden="true">{{ $gettext('Visibility') }}</span>
              <filter-tabs
                :model-value="isPublic ? 'public' : 'private'"
                :tabs="visibilityOptions"
                :label="$gettext('Visibility')"
                @update:model-value="isPublic = $event === 'public'"
              />
            </div>
          </div>
          <p class="ext:m-0 ext:text-xs ext:text-role-on-surface-variant">
            {{
              isPublic
                ? $gettext('People who see your availability also see the title and place of this event.')
                : $gettext('People who see your availability only see that you are busy.')
            }}
          </p>
        </div>

        <color-picker
          v-model="color"
          :calendar-color="calendar?.color ?? '#3b82f6'"
          :disabled="readOnly"
        />

        <oc-text-input v-model="location" :label="$gettext('Location')" :disabled="readOnly" />
        <oc-textarea v-model="description" :label="$gettext('Description')" :disabled="readOnly" />

        <guest-list
          v-if="guestsEditable || guests.length"
          v-model:guests="guests"
          :organizer="event?.organizer && event.organizer.id !== meId ? event.organizer : null"
          :editable="guestsEditable"
          :me-id="meId"
          :can-decide="!!event && guestsEditable"
          :busy="saving"
          @decide="(guest, accept) => emit('decide', guest, accept)"
        />

        <availability-timeline
          v-if="availability && guestsEditable && otherGuests.length"
          :me-id="meId"
          :guests="otherGuests"
          :start="startDate"
          :end="endDate"
          :all-day="allDay"
          :except="event?.uid"
          :move-disabled="timesLocked"
          @move="moveTo"
        />

        <div v-if="event && !readOnly" class="ext:flex ext:justify-start">
          <oc-button appearance="raw" class="ext:text-role-error" :disabled="saving" @click="emit('delete')">
            <oc-icon name="delete-bin" size="small" />
            {{ event.recurring ? $gettext('Delete the whole series') : $gettext('Delete event') }}
          </oc-button>
        </div>
        <button type="submit" hidden />
      </form>
    </template>
  </oc-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useGettext } from 'vue3-gettext'
import { CalendarSource, EventDraft, EventInstance } from '../composables/useCaldav'
import type { Guest, GuestResponse } from '../ical'
import GuestList from './GuestList.vue'
import ColorPicker from './ColorPicker.vue'
import ProposeTime from './ProposeTime.vue'
import AvailabilityTimeline from './AvailabilityTimeline.vue'
import FilterTabs from './FilterTabs.vue'

type Answer = Exclude<GuestResponse, 'pending'>

const props = defineProps<{
  /** Existing occurrence, or null to create one */
  event: EventInstance | null
  /** Pre-filled values (calendar, dates) */
  initial: EventDraft
  calendars: CalendarSource[]
  readOnly: boolean
  /** A recurring occurrence changed on its own: edits apply to it alone */
  modifiedOccurrence?: boolean
  saving: boolean
  meId: string
  /** The event is the current user's own copy of an invitation */
  canRespond: boolean
  /** The server tells when guests are busy */
  availability?: boolean
}>()
const emit = defineEmits<{
  (e: 'save', draft: EventDraft): void
  (e: 'respond', response: Answer): void
  (e: 'propose', proposal: { start: string; end: string }): void
  (e: 'decide', guest: string, accept: boolean): void
  (e: 'delete'): void
  (e: 'close'): void
}>()

const { $gettext } = useGettext()

const title = ref(props.initial.title)
const calendar = ref(props.calendars.find((c) => c.href === props.initial.calendarHref) ?? props.calendars[0])
const allDay = ref(props.initial.allDay)
const location = ref(props.initial.location)
const description = ref(props.initial.description)
const startInput = ref(toInput(props.initial.start, props.initial.allDay))
// All-day ends are exclusive internally but shown inclusive (last day of the event).
const endInput = ref(toInput(inclusiveEnd(props.initial.end, props.initial.allDay), props.initial.allDay))

const guests = ref<Guest[]>([...props.initial.guests])
const proposing = ref(false)
const color = ref<string | null>(props.initial.color)
const busy = ref(props.initial.busy)
const isPublic = ref(props.initial.public)
const visibilityOptions = computed(() => [
  { value: 'private' as const, label: $gettext('Private') },
  { value: 'public' as const, label: $gettext('Public') }
])
// Until the user picks, busy / free follows the all-day toggle (all-day events are free by default).
let busyTouched = !!props.event

function setBusy(value: boolean) {
  busy.value = value
  busyTouched = true
}

const showAsOptions = computed(() => [
  { value: 'busy' as const, label: $gettext('Busy') },
  { value: 'free' as const, label: $gettext('Free') }
])
const otherGuests = computed(() => guests.value.filter((g) => g.id !== props.meId))

const timesLocked = computed(() => !!props.event?.recurring)
const invitation = computed(() => props.canRespond)
const myResponse = computed(() => props.event?.guests.find((g) => g.id === props.meId)?.response ?? 'pending')
const guestsEditable = computed(
  () => !props.readOnly && (!props.event?.organizer || props.event.organizer.id === props.meId)
)
const rsvpOptions = computed(() => [
  { value: 'accepted' as Answer, label: $gettext('Accept'), icon: 'check' },
  { value: 'tentative' as Answer, label: $gettext('Maybe'), icon: 'question' },
  { value: 'declined' as Answer, label: $gettext('Decline'), icon: 'close' }
])
const modalTitle = computed(() => {
  if (!props.event) return $gettext('New event')
  return props.readOnly ? props.event.title || $gettext('Event') : $gettext('Edit event')
})

watch(allDay, (value) => {
  if (!busyTouched) busy.value = !value
  const start = fromInput(startInput.value, !value)
  const end = fromInput(endInput.value, !value)
  if (!start || !end) return
  if (!value && end.getTime() - start.getTime() < 3600_000) {
    // Switching back to a timed event: default to one hour from 09:00.
    start.setHours(9, 0, 0, 0)
    end.setTime(start.getTime() + 3600_000)
  }
  startInput.value = toInput(start, value)
  endInput.value = toInput(end, value)
})

const startDate = computed(() => fromInput(startInput.value, allDay.value))
const endDate = computed(() => {
  const end = fromInput(endInput.value, allDay.value)
  if (end && allDay.value) end.setDate(end.getDate() + 1)
  return end
})
const rangeInvalid = computed(
  () => !!startDate.value && !!endDate.value && endDate.value.getTime() <= startDate.value.getTime()
)
const canSave = computed(
  () => !props.readOnly && !!title.value.trim() && !!startDate.value && !!endDate.value && !rangeInvalid.value && !!calendar.value
)

/** A time picked in the availability timeline: same duration, new start. */
function moveTo(start: Date) {
  if (timesLocked.value || !startDate.value || !endDate.value) return
  const duration = endDate.value.getTime() - startDate.value.getTime()
  startInput.value = toInput(start, false)
  endInput.value = toInput(new Date(start.getTime() + duration), false)
}

function save() {
  if (!canSave.value) return
  emit('save', {
    calendarHref: calendar.value!.href,
    title: title.value.trim(),
    allDay: allDay.value,
    start: startDate.value!,
    end: endDate.value!,
    location: location.value,
    description: description.value,
    guests: guests.value,
    color: color.value,
    busy: busy.value,
    public: isPublic.value
  })
}

function inclusiveEnd(end: Date, isAllDay: boolean) {
  if (!isAllDay) return end
  const d = new Date(end)
  d.setDate(d.getDate() - 1)
  return d
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function toInput(date: Date, dateOnly: boolean) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return dateOnly ? day : `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromInput(value: string, dateOnly: boolean) {
  if (!value) return null
  const [day, time = '00:00'] = value.split('T')
  const [y, m, d] = day.split('-').map(Number)
  const [hh, mm] = dateOnly ? [0, 0] : time.split(':').map(Number)
  const date = new Date(y, m - 1, d, hh, mm)
  return isNaN(date.getTime()) ? null : date
}
</script>

<style scoped>
.rsvp {
  background: color-mix(in srgb, var(--oc-role-primary) 10%, var(--oc-role-surface));
  border: 1px solid color-mix(in srgb, var(--oc-role-primary) 35%, transparent);
}
.dot {
  display: inline-block;
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 9999px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
}
.field input {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--oc-role-outline);
  border-radius: 0.25rem;
  background: var(--oc-role-surface);
  color: var(--oc-role-on-surface);
  font: inherit;
  color-scheme: light dark;
}
.field input:focus {
  outline: 2px solid var(--oc-role-primary);
  outline-offset: -1px;
}
.field input:disabled {
  opacity: 0.6;
}
</style>
