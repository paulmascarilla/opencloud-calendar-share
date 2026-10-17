<template>
  <li
    class="ext:flex ext:items-center ext:gap-3 ext:px-4 ext:py-3 ext:rounded-lg ext:border ext:border-role-outline-variant ext:bg-role-surface"
  >
    <oc-avatar :user-name="displayName(share.owner)" :width="32" />
    <div class="ext:flex-1 ext:min-w-0">
      <div class="ext:font-medium ext:truncate">{{ share.displayName || share.calendar }}</div>
      <div class="ext:text-sm ext:text-role-on-surface-variant ext:truncate">
        {{ $gettext('Shared by %{name}', { name: displayName(share.owner) }) }}
      </div>
    </div>
    <oc-tag size="small" :rounded="true">
      <oc-icon :name="share.permission === 'write' ? 'pencil' : 'eye'" size="xsmall" />
      {{ share.permission === 'write' ? $gettext('Can edit') : $gettext('Can view') }}
    </oc-tag>
    <oc-switch
      :checked="share.accepted"
      :disabled="busy"
      :label="$gettext('Show in my calendar apps')"
      @update:checked="toggle"
    />
  </li>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useMessages } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { apiErrorMessage, Share, useCalshare } from '../composables/useCalshare'
import { useUserDirectory } from '../composables/useUserDirectory'

const props = defineProps<{ share: Share }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const { $gettext } = useGettext()
const { showErrorMessage } = useMessages()
const calshare = useCalshare()
const { displayName } = useUserDirectory()
const busy = ref(false)

async function toggle(accept: boolean) {
  busy.value = true
  try {
    await calshare.respond(props.share.mount, accept)
    emit('changed')
  } catch (error) {
    showErrorMessage({
      title: $gettext('Could not update the shared calendar'),
      desc: apiErrorMessage(error),
      errors: [error as Error]
    })
  } finally {
    busy.value = false
  }
}
</script>
