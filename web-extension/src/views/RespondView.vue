<template>
  <div class="ext:h-full ext:overflow-y-auto ext:bg-role-surface ext:px-4 ext:py-6">
    <div class="ext:max-w-xl ext:mx-auto ext:flex ext:flex-col ext:gap-4">
      <oc-breadcrumb :items="breadcrumb" />

      <div v-if="state === 'loading'" class="ext:flex ext:justify-center ext:py-16">
        <oc-spinner size="large" :aria-label="$gettext('Loading invitation')" />
      </div>

      <oc-notification-message
        v-else-if="state === 'not-found'"
        status="danger"
        :title="$gettext('Invitation not found')"
        :message="
          $gettext(
            'This link does not match an invitation in your calendar. It may have been cancelled, or it was sent to someone else.'
          )
        "
      />

      <section
        v-else-if="event"
        class="ext:rounded-xl ext:border ext:border-role-outline-variant ext:bg-role-surface ext:overflow-hidden"
      >
        <div
          v-if="saved"
          class="saved ext:flex ext:items-center ext:gap-2 ext:px-5 ext:py-3 ext:text-sm ext:font-medium"
          role="status"
        >
          <oc-icon name="checkbox-circle" size="small" />
          <span class="ext:flex-1">
            {{ $gettext('Your answer has been recorded: %{answer}', { answer: answerLabel(myResponse) }) }}
            <span v-if="closingIn !== null" class="ext:block ext:font-normal">
              {{ $gettext('This page will close in %{n} s.', { n: String(closingIn) }) }}
            </span>
            <span v-else-if="closeBlocked" class="ext:block ext:font-normal">
              {{ $gettext('You can close this tab.') }}
            </span>
          </span>
          <oc-button v-if="closingIn !== null" appearance="raw" size="small" @click="keepOpen">
            {{ $gettext('Keep open') }}
          </oc-button>
        </div>

        <div class="ext:px-5 ext:py-4 ext:flex ext:flex-col ext:gap-3">
          <div class="ext:flex ext:items-start ext:gap-3">
            <span class="stripe ext:shrink-0" :style="{ background: event.color ?? 'var(--oc-role-primary)' }" />
            <div class="ext:min-w-0">
              <h1 class="ext:m-0 ext:text-xl ext:font-semibold">{{ event.title || $gettext('(no title)') }}</h1>
              <p class="ext:m-0 ext:mt-1 ext:text-sm ext:text-role-on-surface-variant">{{ when }}</p>
              <p v-if="event.location" class="ext:m-0 ext:mt-1 ext:text-sm ext:flex ext:items-center ext:gap-1">
                <oc-icon name="map-pin" size="xsmall" /> {{ event.location }}
              </p>
            </div>
          </div>

          <p v-if="event.description" class="description ext:m-0 ext:text-sm">{{ event.description }}</p>

          <guest-list :guests="event.guests" :organizer="event.organizer" :editable="false" :me-id="meId" />
        </div>

        <div
          class="ext:flex ext:flex-wrap ext:items-center ext:gap-2 ext:px-5 ext:py-3 ext:border-t ext:border-role-outline-variant ext:bg-role-surface-container-low"
        >
          <span class="ext:text-sm ext:mr-auto">{{ $gettext('Will you attend?') }}</span>
          <oc-button
            v-for="option in options"
            :key="option.value"
            :appearance="myResponse === option.value ? 'filled' : 'outline'"
            size="small"
            :aria-pressed="myResponse === option.value"
            :disabled="sending"
            @click="answer(option.value)"
          >
            <oc-icon :name="option.icon" size="small" />
            {{ option.label }}
          </oc-button>
        </div>
      </section>

      <div v-if="event" class="ext:flex ext:justify-center">
        <oc-button type="router-link" :to="calendarLink" appearance="raw">
          <oc-icon name="calendar-event" size="small" />
          {{ $gettext('Open in the calendar') }}
        </oc-button>
      </div>

      <div class="ext:flex ext:justify-center ext:mt-4">
        <source-link />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, unref } from 'vue'
import { useMessages, useRoute, useRouter, useUserStore } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { EventInstance, useCaldav } from '../composables/useCaldav'
import { apiErrorMessage, useCalshare } from '../composables/useCalshare'
import type { GuestResponse } from '../ical'
import GuestList from '../components/GuestList.vue'
import SourceLink from '../components/SourceLink.vue'

type Answer = Exclude<GuestResponse, 'pending'>
const ANSWERS: Answer[] = ['accepted', 'tentative', 'declined']
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/

const { $gettext, current } = useGettext()
const { showErrorMessage } = useMessages()
const route = useRoute()
const router = useRouter()
const caldav = useCaldav()
const calshare = useCalshare()
const meId = computed(() => useUserStore().user?.id ?? '')

const state = ref<'loading' | 'ready' | 'not-found'>('loading')
const event = ref<EventInstance | null>(null)
const sending = ref(false)
const saved = ref(false)
/** Opened from the link in a CalDAV client: close the tab once the answer is saved. */
const fromLink = ref(false)
const closingIn = ref<number | null>(null)
const closeBlocked = ref(false)
let closeTimer: ReturnType<typeof setInterval> | undefined

const query = computed(() => unref(route).query)
const calendar = computed(() => String(query.value.cal ?? ''))
const file = computed(() => String(query.value.event ?? ''))

const myResponse = computed<GuestResponse>(
  () => event.value?.guests.find((g) => g.id === meId.value)?.response ?? 'pending'
)
const breadcrumb = computed(() => [
  { text: $gettext('Calendar'), to: { name: 'calendar-main' } },
  { text: $gettext('Invitation') }
])
const options = computed(() => [
  { value: 'accepted' as Answer, label: $gettext('Accept'), icon: 'check' },
  { value: 'tentative' as Answer, label: $gettext('Maybe'), icon: 'question' },
  { value: 'declined' as Answer, label: $gettext('Decline'), icon: 'close' }
])
const when = computed(() => {
  const e = event.value
  if (!e) return ''
  const text = e.allDay ? allDayRange(e.start, e.end) : timedRange(new Date(e.start), e.end ? new Date(e.end) : null)
  // A series is shown from its first occurrence.
  return e.recurring ? $gettext('Recurring, from %{when}', { when: text }) : text
})

function allDayRange(start: string, end: string | null) {
  const first = localDay(start)
  // All-day ends are exclusive: show the last day.
  const last = end ? localDay(end) : new Date(first)
  if (end) last.setDate(last.getDate() - 1)
  const day = new Intl.DateTimeFormat(current, { dateStyle: 'full' })
  return `${last > first ? day.formatRange(first, last) : day.format(first)} · ${$gettext('All day')}`
}

function timedRange(start: Date, end: Date | null) {
  if (end && localDate(end) !== localDate(start)) {
    return new Intl.DateTimeFormat(current, { dateStyle: 'full', timeStyle: 'short' }).formatRange(start, end)
  }
  const day = new Intl.DateTimeFormat(current, { dateStyle: 'full' }).format(start)
  const time = new Intl.DateTimeFormat(current, { hour: '2-digit', minute: '2-digit' })
  return `${day} · ${end ? time.formatRange(start, end) : time.format(start)}`
}

/** YYYY-MM-DD at local midnight (``new Date('YYYY-MM-DD')`` would be UTC midnight). */
function localDay(date: string) {
  return new Date(`${date}T00:00:00`)
}

/** Local YYYY-MM-DD of a date-time: the day the user sees it on. */
function localDate(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const calendarLink = computed(() => {
  const e = event.value
  // A series opens on today: its first occurrence may be long past.
  if (!e || e.recurring) return { name: 'calendar-main' }
  return { name: 'calendar-main', query: { date: e.allDay ? e.start : localDate(new Date(e.start)) } }
})

function answerLabel(response: GuestResponse) {
  return {
    pending: $gettext('Awaiting answer'),
    accepted: $gettext('Accepted'),
    tentative: $gettext('Maybe'),
    declined: $gettext('Declined')
  }[response]
}

async function load() {
  if (!SEGMENT.test(calendar.value) || !SEGMENT.test(file.value)) {
    state.value = 'not-found'
    return null
  }
  const found = await caldav.getEvent(`/caldav/${meId.value}/${calendar.value}/${file.value}`)
  // Only the guest's own copy can be answered here.
  if (!found?.invitationFrom || !found.guests.some((g) => g.id === meId.value)) {
    state.value = 'not-found'
    return null
  }
  event.value = found
  state.value = 'ready'
  return found
}

function scheduleClose() {
  if (!fromLink.value) return
  clearInterval(closeTimer)
  closeBlocked.value = false
  closingIn.value = 3
  closeTimer = setInterval(() => {
    closingIn.value = (closingIn.value ?? 1) - 1
    if (closingIn.value > 0) return
    clearInterval(closeTimer)
    closingIn.value = null
    // Browsers only let a page close itself when it was opened directly (no login
    // redirects in its history). Otherwise say so instead of pretending.
    window.close()
    setTimeout(() => (closeBlocked.value = !window.closed), 300)
  }, 1000)
}

function keepOpen() {
  clearInterval(closeTimer)
  closingIn.value = null
  fromLink.value = false
}

async function answer(response: Answer) {
  sending.value = true
  try {
    await calshare.answerInvitation(calendar.value, file.value, response)
    await load()
    saved.value = true
    scheduleClose()
  } catch (error) {
    showErrorMessage({
      title: $gettext('Could not send your answer'),
      desc: apiErrorMessage(error),
      errors: [error as Error]
    })
  } finally {
    sending.value = false
  }
}

onMounted(async () => {
  const found = await load()
  const requested = String(query.value.response ?? '') as Answer
  if (found && ANSWERS.includes(requested)) {
    fromLink.value = true
    // Drop ?response so reloading the page does not answer again.
    const { response: _ignored, ...rest } = query.value
    router.replace({ query: rest })
    if (requested !== myResponse.value) {
      await answer(requested)
    } else {
      saved.value = true
      scheduleClose()
    }
  }
})

onBeforeUnmount(() => clearInterval(closeTimer))
</script>

<style scoped>
.stripe {
  width: 0.35rem;
  align-self: stretch;
  border-radius: 9999px;
}
.saved {
  background: color-mix(in srgb, var(--oc-role-primary) 12%, var(--oc-role-surface));
  color: var(--oc-role-on-surface);
}
.description {
  white-space: pre-line;
  color: var(--oc-role-on-surface-variant);
}
</style>
