<template>
  <fieldset class="ext:m-0 ext:p-0 ext:border-0" :disabled="disabled">
    <legend class="ext:text-sm ext:mb-1">{{ $gettext('Color') }}</legend>
    <div class="ext:flex ext:flex-wrap ext:items-center ext:gap-2" role="radiogroup">
      <button
        v-for="option in options"
        :key="option.value ?? 'calendar'"
        type="button"
        role="radio"
        class="swatch"
        :class="{ selected: modelValue === option.value, 'calendar-default': option.value === null }"
        :style="{ '--swatch': option.css }"
        :aria-checked="modelValue === option.value"
        :aria-label="option.label"
        :title="option.label"
        @click="emit('update:modelValue', option.value)"
      />
    </div>
  </fieldset>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import { PALETTE, PaletteColor } from '../palette'

const props = withDefaults(
  defineProps<{
    modelValue: string | null
    calendarColor?: string
    disabled?: boolean
    /** First swatch = "use the calendar's color" (events only) */
    withCalendarColor?: boolean
  }>(),
  { calendarColor: '#3b82f6', withCalendarColor: true }
)
const emit = defineEmits<{ (e: 'update:modelValue', value: string | null): void }>()
const { $gettext } = useGettext()

const names = computed<Record<PaletteColor, string>>(() => ({
  royalblue: $gettext('Blue'),
  mediumpurple: $gettext('Purple'),
  orchid: $gettext('Pink'),
  crimson: $gettext('Red'),
  darkorange: $gettext('Orange'),
  goldenrod: $gettext('Yellow'),
  seagreen: $gettext('Green'),
  teal: $gettext('Teal'),
  slategray: $gettext('Gray')
}))

const options = computed(() => [
  ...(props.withCalendarColor ? [{ value: null, css: props.calendarColor, label: $gettext('Calendar color') }] : []),
  ...PALETTE.map((c) => ({ value: c as string | null, css: c as string, label: names.value[c] }))
])
</script>

<style scoped>
.swatch {
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 9999px;
  border: 2px solid var(--oc-role-surface);
  background: var(--swatch);
  box-shadow: 0 0 0 1px var(--oc-role-outline-variant);
  cursor: pointer;
  padding: 0;
}
.swatch.calendar-default {
  /* "calendar color": half-filled, to tell it apart from the fixed colors */
  background: linear-gradient(135deg, var(--swatch) 50%, var(--oc-role-surface) 50%);
}
.swatch.selected {
  box-shadow: 0 0 0 2px var(--oc-role-on-surface);
}
.swatch:focus-visible {
  outline: 2px solid var(--oc-role-primary);
  outline-offset: 2px;
}
fieldset:disabled .swatch {
  cursor: default;
  opacity: 0.6;
}
</style>
