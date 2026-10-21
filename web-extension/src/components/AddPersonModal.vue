<template>
  <oc-modal
    :title="$gettext('Add a person')"
    :button-confirm-text="$gettext('Add')"
    :button-confirm-disabled="!user"
    focus-trap-initial=".add-person input"
    @confirm="add"
    @cancel="emit('close')"
  >
    <template #content>
      <form class="add-person ext:flex ext:flex-col ext:gap-4" @submit.prevent="add">
        <div class="ext:flex ext:flex-col ext:gap-1">
          <span class="ext:text-sm">{{ $gettext('Person') }}</span>
          <user-picker
            v-model="user"
            :exclude-ids="excludeIds"
            :label="$gettext('Person')"
            :placeholder="$gettext('Search people by name, username or e-mail')"
          />
        </div>
        <color-picker v-model="color" :with-calendar-color="false" />
        <p class="ext:m-0 ext:text-sm ext:text-role-on-surface-variant">
          {{
            $gettext(
              'Their busy times appear in your calendar. You only see when they are busy, and the events they made public.'
            )
          }}
        </p>
        <button type="submit" hidden />
      </form>
    </template>
  </oc-modal>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { DirectoryUser } from '../composables/useUserDirectory'
import { PALETTE_HEX, PaletteColor } from '../palette'
import ColorPicker from './ColorPicker.vue'
import UserPicker from './UserPicker.vue'

const props = defineProps<{
  /** Already shown, or me */
  excludeIds: string[]
  /** Suggested color (palette name): one no calendar or person uses yet */
  defaultColor: PaletteColor
}>()
const emit = defineEmits<{
  (e: 'add', person: { user: DirectoryUser; color: string }): void
  (e: 'close'): void
}>()

const user = ref<DirectoryUser | null>(null)
const color = ref<string | null>(props.defaultColor)

function add() {
  if (!user.value) return
  emit('add', { user: user.value, color: PALETTE_HEX[(color.value ?? props.defaultColor) as PaletteColor] })
}
</script>
