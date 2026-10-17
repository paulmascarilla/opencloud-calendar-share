<template>
  <oc-select
    :model-value="selected"
    :options="options"
    :searchable="false"
    :clearable="false"
    :disabled="disabled"
    :label="$gettext('Permission')"
    :label-hidden="true"
    option-label="label"
    class="ext:w-40"
    @update:model-value="emit('update:modelValue', $event.value)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import { Permission } from '../composables/useCalshare'

const props = defineProps<{ modelValue: Permission; disabled?: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: Permission): void }>()

const { $gettext } = useGettext()
const options = computed(() => [
  { value: 'read' as Permission, label: $gettext('Can view') },
  { value: 'write' as Permission, label: $gettext('Can edit') }
])
const selected = computed(() => options.value.find((o) => o.value === props.modelValue))
</script>
