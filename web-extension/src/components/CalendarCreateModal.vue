<template>
  <oc-modal
    :title="$gettext('New calendar')"
    :button-confirm-text="$gettext('Create')"
    :button-confirm-disabled="!name.trim() || saving"
    :is-loading="saving"
    focus-trap-initial="#calendar-name"
    @confirm="create"
    @cancel="emit('close')"
  >
    <template #content>
      <form class="ext:flex ext:flex-col ext:gap-4" @submit.prevent="create">
        <oc-text-input id="calendar-name" v-model="name" :label="$gettext('Name')" :required-mark="true" />
        <color-picker v-model="color" :with-calendar-color="false" />
        <p class="ext:m-0 ext:text-sm ext:text-role-on-surface-variant">
          {{ $gettext('It also appears in your CalDAV apps, and you can share it with other people.') }}
        </p>
        <button type="submit" hidden />
      </form>
    </template>
  </oc-modal>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useMessages } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { useCaldav } from '../composables/useCaldav'
import { PALETTE_HEX, PaletteColor } from '../palette'
import ColorPicker from './ColorPicker.vue'

const emit = defineEmits<{ (e: 'created', href: string): void; (e: 'close'): void }>()
const { $gettext } = useGettext()
const { showMessage, showErrorMessage } = useMessages()
const caldav = useCaldav()

const name = ref('')
const color = ref<string | null>('seagreen')
const saving = ref(false)

async function create() {
  if (!name.value.trim() || saving.value) return
  saving.value = true
  try {
    const href = await caldav.createCalendar(name.value.trim(), PALETTE_HEX[(color.value ?? 'royalblue') as PaletteColor])
    showMessage({ title: $gettext('Calendar “%{name}” created', { name: name.value.trim() }) })
    emit('created', href)
  } catch (error) {
    showErrorMessage({ title: $gettext('Could not create the calendar'), errors: [error as Error] })
  } finally {
    saving.value = false
  }
}
</script>
