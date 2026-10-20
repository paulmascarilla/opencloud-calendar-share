<template>
  <form class="ext:flex ext:flex-col ext:gap-2" @submit.prevent="submit">
    <div class="ext:grid ext:grid-cols-1 ext:sm:grid-cols-2 ext:gap-2">
      <label class="field">
        <span>{{ $gettext('Start') }}</span>
        <input v-model="startInput" :type="allDay ? 'date' : 'datetime-local'" required />
      </label>
      <label class="field">
        <span>{{ $gettext('End') }}</span>
        <input v-model="endInput" :type="allDay ? 'date' : 'datetime-local'" required />
      </label>
    </div>
    <p v-if="invalid" class="ext:m-0 ext:text-sm ext:text-role-error">
      {{ $gettext('The end must be after the start.') }}
    </p>
    <div class="ext:flex ext:flex-wrap ext:gap-2">
      <oc-button size="small" appearance="filled" :disabled="!range || sending" @click="submit">
        {{ $gettext('Send the proposal') }}
      </oc-button>
      <oc-button size="small" appearance="outline" :disabled="sending" @click="emit('cancel')">
        {{ $gettext('Cancel') }}
      </oc-button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  /** The event's current times; all-day ends are exclusive */
  start: Date
  end: Date
  allDay: boolean
  sending: boolean
}>()
const emit = defineEmits<{
  (e: 'submit', proposal: { start: string; end: string }): void
  (e: 'cancel'): void
}>()

const pad = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const toInput = (d: Date) => (props.allDay ? day(d) : `${day(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`)

// All-day ends are shown inclusive (the last day), like in the event editor.
const lastDay = new Date(props.end)
if (props.allDay) lastDay.setDate(lastDay.getDate() - 1)
const startInput = ref(toInput(props.start))
const endInput = ref(toInput(lastDay))

/** ISO values for the API: YYYY-MM-DD (end exclusive) or UTC date-times; null when incomplete. */
const range = computed(() => {
  if (!startInput.value || !endInput.value) return null
  if (props.allDay) {
    const end = new Date(`${endInput.value}T00:00:00`)
    end.setDate(end.getDate() + 1)
    return end > new Date(`${startInput.value}T00:00:00`) ? { start: startInput.value, end: day(end) } : null
  }
  const start = new Date(startInput.value)
  const end = new Date(endInput.value)
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return null
  return { start: start.toISOString(), end: end.toISOString() }
})
const invalid = computed(() => !!startInput.value && !!endInput.value && !range.value)

function submit() {
  if (range.value && !props.sending) emit('submit', range.value)
}
</script>

<style scoped>
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
</style>
