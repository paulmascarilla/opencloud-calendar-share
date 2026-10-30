<template>
  <oc-modal
    v-if="!confirmingDelete"
    :title="$gettext('Calendar settings')"
    :button-confirm-text="$gettext('Save')"
    :button-confirm-disabled="!name.trim() || !changed || busy"
    :is-loading="busy"
    focus-trap-initial="#calendar-settings-name"
    @confirm="save"
    @cancel="emit('close')"
  >
    <template #content>
      <form class="ext:flex ext:flex-col ext:gap-4" @submit.prevent="save">
        <oc-text-input id="calendar-settings-name" v-model="name" :label="$gettext('Name')" :required-mark="true" />
        <color-picker v-model="color" :calendar-color="calendar.color" :with-calendar-color="!initialColor" />
        <p v-if="shareCount" class="ext:m-0 ext:text-sm ext:text-role-on-surface-variant">
          {{
            $ngettext(
              'Shared with %{n} person: they see the new name and color.',
              'Shared with %{n} people: they see the new name and color.',
              shareCount,
              { n: String(shareCount) }
            )
          }}
        </p>
        <div class="ext:flex ext:justify-start">
          <oc-button
            appearance="raw"
            class="ext:text-role-error"
            :disabled="busy || isDefault"
            :title="isDefault ? $gettext('Your default calendar cannot be deleted') : undefined"
            @click="confirmingDelete = true"
          >
            <oc-icon name="delete-bin" size="small" />
            {{ $gettext('Delete calendar') }}
          </oc-button>
        </div>
        <button type="submit" hidden />
      </form>
    </template>
  </oc-modal>

  <oc-modal
    v-else
    :title="$gettext('Delete “%{name}”?', { name: calendar.name })"
    hide-actions
    @cancel="confirmingDelete = false"
  >
    <template #content>
      <ul class="consequences ext:list-none ext:m-0 ext:p-0 ext:flex ext:flex-col ext:gap-3 ext:text-sm">
        <li>
          <oc-icon name="delete-bin" size="small" />
          <span>{{ eventsText }}</span>
        </li>
        <li v-if="sharedWith.length">
          <oc-icon name="user-unfollow" size="small" />
          <span>{{ accessText }}</span>
        </li>
        <li v-if="organizedCount">
          <oc-icon name="calendar-close" size="small" />
          <span>
            {{
              $ngettext(
                'You organized %{n} event in it: it disappears from your guests\' calendars.',
                'You organized %{n} events in it: they disappear from your guests\' calendars.',
                organizedCount,
                { n: String(organizedCount) }
              )
            }}
          </span>
        </li>
        <li v-if="receivedCount">
          <oc-icon name="mail-close" size="small" />
          <span>
            {{
              $ngettext(
                '%{n} invitation you received is in it: it is declined.',
                '%{n} invitations you received are in it: they are declined.',
                receivedCount,
                { n: String(receivedCount) }
              )
            }}
          </span>
        </li>
      </ul>
      <p class="warning ext:flex ext:items-center ext:gap-2 ext:mt-4 ext:mb-0 ext:px-3 ext:py-2 ext:rounded ext:text-sm">
        <oc-icon name="error-warning" size="small" />
        {{ $gettext('This cannot be undone.') }}
      </p>
      <div class="ext:flex ext:justify-end ext:gap-2 ext:mt-6">
        <oc-button appearance="outline" :disabled="busy" @click="confirmingDelete = false">
          {{ $gettext('Cancel') }}
        </oc-button>
        <oc-button appearance="filled" class="danger" :disabled="busy" @click="remove">
          <oc-spinner v-if="busy" size="small" />
          {{ $gettext('Delete calendar') }}
        </oc-button>
      </div>
    </template>
  </oc-modal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useMessages } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { apiErrorMessage, useCalshare } from '../composables/useCalshare'
import { CalendarSource, useCaldav } from '../composables/useCaldav'
import { PALETTE, PALETTE_HEX, PaletteColor } from '../palette'
import { useUserDirectory } from '../composables/useUserDirectory'
import ColorPicker from './ColorPicker.vue'

const props = defineProps<{ calendar: CalendarSource }>()
const emit = defineEmits<{ (e: 'saved' | 'deleted' | 'close'): void }>()
const { $gettext, $ngettext } = useGettext()
const { showMessage, showErrorMessage } = useMessages()
const calshare = useCalshare()
const caldav = useCaldav()
const { displayName } = useUserDirectory()

// A color set in another app has no swatch: null keeps it ("calendar color").
const initialColor =
  PALETTE.find((c) => PALETTE_HEX[c].toLowerCase() === props.calendar.color.toLowerCase()) ?? null
const name = ref(props.calendar.name)
const color = ref<string | null>(initialColor)
/** Ids of the people the calendar is shared with */
const sharedWith = ref<string[]>([])
const shareCount = computed(() => sharedWith.value.length)
/** null until counted */
const eventCount = ref<number | null>(null)
const organizedCount = ref(0)
const receivedCount = ref(0)
const busy = ref(false)
const confirmingDelete = ref(false)

const isDefault = computed(() => props.calendar.id === 'def-calendar')
const changed = computed(() => name.value.trim() !== props.calendar.name || color.value !== initialColor)

onMounted(async () => {
  // Only used for the wording: each count is left out if it cannot be read.
  const [shares, events, invitations] = await Promise.allSettled([
    calshare.listOutgoing(),
    caldav.countEvents(props.calendar.href),
    calshare.listInvitations()
  ])
  if (shares.status === 'fulfilled') {
    sharedWith.value = shares.value
      .filter((s) => s.calendar === props.calendar.id)
      .map((s) => s.user.id)
  }
  if (events.status === 'fulfilled') eventCount.value = events.value
  if (invitations.status === 'fulfilled') {
    // The index holds Radicale paths, without the /caldav prefix.
    const prefix = props.calendar.href.replace(/^\/caldav/, '')
    organizedCount.value = invitations.value.organized.filter((p) => p.startsWith(prefix)).length
    receivedCount.value = invitations.value.received.filter((r) => r.copy.startsWith(prefix)).length
  }
})

const eventsText = computed(() => {
  if (eventCount.value === 0) return $gettext('It has no events.')
  if (eventCount.value === null) return $gettext('Its events are deleted, here and in your CalDAV apps.')
  return $ngettext(
    'Its %{n} event is deleted, here and in your CalDAV apps.',
    'Its %{n} events are deleted, here and in your CalDAV apps.',
    eventCount.value,
    { n: String(eventCount.value) }
  )
})

const accessText = computed(() => {
  const [first, second] = sharedWith.value.map(displayName)
  const others = sharedWith.value.length - 2
  if (sharedWith.value.length === 1) return $gettext('%{name} loses access.', { name: first })
  if (sharedWith.value.length === 2) return $gettext('%{a} and %{b} lose access.', { a: first, b: second })
  return $ngettext(
    '%{a}, %{b} and %{n} other person lose access.',
    '%{a}, %{b} and %{n} other people lose access.',
    others,
    { a: first, b: second, n: String(others) }
  )
})

async function save() {
  if (!name.value.trim() || !changed.value || busy.value) return
  busy.value = true
  try {
    await calshare.updateCalendar(props.calendar.id, {
      ...(name.value.trim() !== props.calendar.name ? { displayName: name.value.trim() } : {}),
      ...(color.value && color.value !== initialColor ? { color: PALETTE_HEX[color.value as PaletteColor] } : {})
    })
    showMessage({ title: $gettext('Calendar “%{name}” saved', { name: name.value.trim() }) })
    emit('saved')
  } catch (error) {
    showErrorMessage({
      title: $gettext('Could not save the calendar'),
      desc: apiErrorMessage(error),
      errors: [error as Error]
    })
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (busy.value) return
  busy.value = true
  try {
    await calshare.deleteCalendar(props.calendar.id)
    showMessage({ title: $gettext('Calendar “%{name}” deleted', { name: props.calendar.name }) })
    emit('deleted')
  } catch (error) {
    showErrorMessage({
      title: $gettext('Could not delete the calendar'),
      desc: apiErrorMessage(error),
      errors: [error as Error]
    })
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.consequences li {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}
.consequences .oc-icon {
  flex-shrink: 0;
  margin-top: 0.125rem;
  color: var(--oc-role-on-surface-variant);
}
.warning {
  background-color: color-mix(in srgb, var(--oc-role-error) 12%, transparent);
  color: var(--oc-role-error);
  font-weight: 600;
}
.danger {
  background-color: var(--oc-role-error) !important;
  color: var(--oc-role-on-error) !important;
}
</style>
