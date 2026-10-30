<template>
  <div class="ext:flex ext:flex-col ext:gap-3">
    <label class="field">
      <span>{{ $gettext('Repeat') }}</span>
      <select v-model="preset" :disabled="disabled">
        <option v-for="option in presetOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>

    <div v-if="preset === 'custom'" class="custom ext:flex ext:flex-col ext:gap-3 ext:p-3 ext:rounded">
      <div class="ext:flex ext:flex-wrap ext:items-center ext:gap-2 ext:text-sm">
        <span>{{ $gettext('Every') }}</span>
        <input
          v-model.number="custom.interval"
          type="number"
          min="1"
          max="99"
          class="number"
          :aria-label="$gettext('Interval')"
          :disabled="disabled"
        />
        <select v-model="custom.freq" :aria-label="$gettext('Unit')" :disabled="disabled">
          <option value="DAILY">{{ $ngettext('day', 'days', custom.interval) }}</option>
          <option value="WEEKLY">{{ $ngettext('week', 'weeks', custom.interval) }}</option>
          <option value="MONTHLY">{{ $ngettext('month', 'months', custom.interval) }}</option>
          <option value="YEARLY">{{ $ngettext('year', 'years', custom.interval) }}</option>
        </select>
      </div>

      <div
        v-if="custom.freq === 'WEEKLY'"
        class="ext:flex ext:flex-wrap ext:gap-1"
        role="group"
        :aria-label="$gettext('On these days')"
      >
        <button
          v-for="day in weekOrder"
          :key="day"
          type="button"
          class="day"
          :class="{ selected: custom.weekdays.includes(day) }"
          :aria-pressed="custom.weekdays.includes(day)"
          :title="dayName(day)"
          :disabled="disabled"
          @click="toggleDay(day)"
        >
          {{ dayName(day, 'short') }}
        </button>
      </div>

      <p
        v-if="custom.freq === 'WEEKLY' && !custom.weekdays.includes(weekdayOf(anchor))"
        class="ext:m-0 ext:text-xs ext:text-role-on-surface-variant"
      >
        {{ $gettext('The event moves to the first day you picked.') }}
      </p>

      <div v-if="custom.freq === 'MONTHLY'" class="ext:flex ext:flex-col ext:gap-1 ext:text-sm" role="radiogroup">
        <label class="ext:inline-flex ext:items-center ext:gap-2">
          <input v-model="custom.monthlyBy" type="radio" value="day" :disabled="disabled" />
          {{ $gettext('On day %{n}', { n: String(anchor.getDate()) }) }}
        </label>
        <label class="ext:inline-flex ext:items-center ext:gap-2">
          <input v-model="custom.monthlyBy" type="radio" value="weekday" :disabled="disabled" />
          {{ $gettext('On %{nth}', { nth: nthDay(anchor) }) }}
        </label>
      </div>
    </div>

    <div v-if="preset !== 'none'" class="ext:flex ext:flex-wrap ext:items-center ext:gap-2 ext:text-sm">
      <label class="ext:inline-flex ext:items-center ext:gap-2">
        <span>{{ $gettext('Ends') }}</span>
        <select v-model="ends" :disabled="disabled">
          <option value="never">{{ $gettext('Never') }}</option>
          <option value="until">{{ $gettext('On a date') }}</option>
          <option value="count">{{ $gettext('After a number of times') }}</option>
        </select>
      </label>
      <input
        v-if="ends === 'until'"
        v-model="until"
        type="date"
        :min="anchorDay"
        :aria-label="$gettext('Last day')"
        :disabled="disabled"
      />
      <template v-if="ends === 'count'">
        <input
          v-model.number="count"
          type="number"
          min="1"
          max="999"
          class="number"
          :aria-label="$gettext('Number of times')"
          :disabled="disabled"
        />
        <span>{{ $ngettext('time', 'times', count || 0) }}</span>
      </template>
    </div>

    <!-- the whole rule in words, when the selected preset alone does not say it -->
    <p
      v-if="modelValue && (preset === 'custom' || modelValue.until || modelValue.count)"
      class="ext:m-0 ext:text-xs ext:text-role-on-surface-variant"
    >
      {{ summary(modelValue, anchor) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Preset, presetOf, presetRepeat, Repeat, Weekday, WEEKDAYS, weekdayOf } from '../repeat'
import { useRepeatText } from '../composables/useRepeatText'

const props = defineProps<{
  modelValue: Repeat | null
  /** Start of the series (or of the new event): presets are built from it */
  anchor: Date
  disabled?: boolean
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: Repeat | null): void }>()
const { dayName, nthDay, presetLabel, summary } = useRepeatText()

const PRESETS: Preset[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'monthly-weekday', 'yearly', 'custom']
const presetOptions = computed(() => PRESETS.map((p) => ({ value: p, label: presetLabel(p, props.anchor) })))
// Monday first, as in the calendar
const weekOrder: Weekday[] = [...WEEKDAYS.slice(1), WEEKDAYS[0]]

const initial = props.modelValue
const preset = ref<Preset>(presetOf(initial, props.anchor))
const custom = reactive<Repeat>(
  initial
    ? { ...initial, weekdays: [...initial.weekdays] }
    : { freq: 'WEEKLY', interval: 1, weekdays: [weekdayOf(props.anchor)], monthlyBy: 'day', until: null, count: null }
)
const ends = ref<'never' | 'until' | 'count'>(initial?.until ? 'until' : initial?.count ? 'count' : 'never')
const until = ref(initial?.until ?? '')
const count = ref(initial?.count ?? 10)

const anchorDay = computed(() => {
  const d = props.anchor
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})

function toggleDay(day: Weekday) {
  const days = custom.weekdays.includes(day) ? custom.weekdays.filter((d) => d !== day) : [...custom.weekdays, day]
  // At least one day: the series' own.
  custom.weekdays = days.length ? days : [weekdayOf(props.anchor)]
}

const value = computed<Repeat | null>(() => {
  const rule =
    preset.value === 'custom'
      ? { ...custom, interval: Math.min(99, Math.max(1, Math.round(custom.interval) || 1)), weekdays: [...custom.weekdays] }
      : presetRepeat(preset.value, props.anchor)
  if (!rule) return null
  return {
    ...rule,
    until: ends.value === 'until' && until.value ? until.value : null,
    count: ends.value === 'count' && count.value > 0 ? Math.min(999, Math.round(count.value)) : null
  }
})

watch(preset, (p) => {
  // Custom starts from the preset that was shown.
  if (p === 'custom' && props.modelValue) Object.assign(custom, { ...props.modelValue, weekdays: [...props.modelValue.weekdays] })
})
watch(value, (v) => emit('update:modelValue', v), { deep: true })
</script>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
}
select,
input[type='date'],
.number {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--oc-role-outline);
  border-radius: 0.25rem;
  background: var(--oc-role-surface);
  color: var(--oc-role-on-surface);
  font: inherit;
  color-scheme: light dark;
}
.number {
  width: 4.5rem;
}
.custom {
  background: var(--oc-role-surface-container);
}
.day {
  min-width: 2.75rem;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--oc-role-outline-variant);
  border-radius: 9999px;
  background: var(--oc-role-surface);
  color: var(--oc-role-on-surface);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}
.day.selected {
  background: var(--oc-role-primary);
  border-color: var(--oc-role-primary);
  color: var(--oc-role-on-primary);
}
.day:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: 2px solid var(--oc-role-primary);
  outline-offset: 1px;
}
:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
