<template>
  <div
    class="ext:inline-flex ext:flex-wrap ext:gap-0.5 ext:p-0.5 ext:rounded-lg ext:border ext:border-role-outline-variant ext:bg-role-surface-container-low"
    role="radiogroup"
    :aria-label="label"
  >
    <button
      v-for="tab in tabs"
      :key="tab.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === tab.value"
      class="tab ext:inline-flex ext:items-center ext:gap-1.5 ext:px-3 ext:py-1 ext:rounded-md ext:text-sm"
      :class="{ active: modelValue === tab.value }"
      @click="emit('update:modelValue', tab.value)"
    >
      {{ tab.label }}
      <span v-if="tab.count" class="count ext:text-xs ext:font-semibold ext:px-1.5 ext:rounded">{{ tab.count }}</span>
    </button>
  </div>
</template>

<script setup lang="ts" generic="T extends string">
defineProps<{
  modelValue: T
  tabs: { value: T; label: string; count?: number }[]
  label: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: T): void }>()
</script>

<style scoped>
.tab {
  border: 1px solid transparent;
  background: transparent;
  color: var(--oc-role-on-surface-variant);
  cursor: pointer;
  font: inherit;
  font-size: 0.875rem;
}
.tab:hover {
  color: var(--oc-role-on-surface);
}
.tab:focus-visible {
  outline: 2px solid var(--oc-role-primary);
  outline-offset: 1px;
}
.tab.active {
  background: var(--oc-role-surface);
  border-color: var(--oc-role-outline-variant);
  color: var(--oc-role-on-surface);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
}
.count {
  background: var(--oc-role-on-surface);
  color: var(--oc-role-surface);
}
</style>
