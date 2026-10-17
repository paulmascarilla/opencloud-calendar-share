<template>
  <section
    class="calendar-card ext:rounded-lg ext:border ext:border-role-outline-variant ext:bg-role-surface"
  >
    <header class="ext:flex ext:items-center ext:gap-3 ext:px-4 ext:py-3">
      <span
        class="ext:inline-block ext:w-3 ext:h-3 ext:rounded-full ext:shrink-0"
        :style="{ backgroundColor: calendar.color || 'var(--oc-role-outline)' }"
      />
      <h3 class="ext:m-0 ext:text-base ext:font-semibold ext:flex-1 ext:truncate">
        {{ calendar.displayName }}
        <span class="ext:font-normal ext:text-sm ext:text-role-on-surface-variant">
          · {{ componentLabel }}
        </span>
      </h3>
      <span class="ext:text-sm ext:text-role-on-surface-variant">
        {{
          $ngettext('Shared with %{n} person', 'Shared with %{n} people', shares.length, {
            n: String(shares.length)
          })
        }}
      </span>
    </header>

    <ul v-if="shares.length" class="ext:list-none ext:m-0 ext:px-4 ext:pb-2">
      <li
        v-for="share in shares"
        :key="share.user.id"
        class="ext:flex ext:items-center ext:gap-3 ext:py-2 ext:border-t ext:border-role-outline-variant"
      >
        <oc-avatar :user-name="displayName(share.user.id)" :width="32" />
        <div class="ext:flex-1 ext:min-w-0">
          <div class="ext:truncate">{{ displayName(share.user.id) }}</div>
          <div v-if="!share.accepted" class="ext:text-xs ext:text-role-on-surface-variant">
            {{ $gettext('Hidden by recipient') }}
          </div>
        </div>
        <permission-select
          :model-value="share.permission"
          :disabled="busy"
          @update:model-value="changePermission(share, $event)"
        />
        <oc-button
          appearance="raw"
          size="small"
          :disabled="busy"
          :aria-label="$gettext('Stop sharing with %{name}', { name: displayName(share.user.id) })"
          :title="$gettext('Stop sharing')"
          @click="removeShare(share)"
        >
          <oc-icon name="close" size="small" />
        </oc-button>
      </li>
    </ul>

    <div
      class="ext:flex ext:flex-wrap ext:items-center ext:gap-2 ext:px-4 ext:py-3 ext:border-t ext:border-role-outline-variant ext:bg-role-surface-container-low"
    >
      <user-picker
        v-model="recipient"
        :exclude-ids="[ownerId, ...shares.map((s) => s.user.id)]"
      />
      <permission-select v-model="permission" :disabled="busy" />
      <oc-button appearance="filled" :disabled="!recipient || busy" @click="addShare">
        <oc-icon name="user-add" size="small" />
        {{ $gettext('Share') }}
      </oc-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMessages } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { apiErrorMessage, Calendar, Permission, Share, useCalshare } from '../composables/useCalshare'
import { DirectoryUser, useUserDirectory } from '../composables/useUserDirectory'
import PermissionSelect from './PermissionSelect.vue'
import UserPicker from './UserPicker.vue'

const props = defineProps<{ calendar: Calendar; shares: Share[]; ownerId: string }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const { $gettext } = useGettext()
const { showMessage, showErrorMessage } = useMessages()
const calshare = useCalshare()
const { displayName, remember } = useUserDirectory()

const recipient = ref<DirectoryUser | null>(null)
const permission = ref<Permission>('read')
const busy = ref(false)

const componentLabel = computed(() =>
  props.calendar.components.includes('VTODO') && !props.calendar.components.includes('VEVENT')
    ? $gettext('Tasks')
    : $gettext('Events')
)

async function run(action: () => Promise<unknown>, errorTitle: string) {
  busy.value = true
  try {
    await action()
    emit('changed')
    return true
  } catch (error) {
    showErrorMessage({
      title: errorTitle,
      desc: apiErrorMessage(error),
      errors: [error as Error]
    })
    return false
  } finally {
    busy.value = false
  }
}

async function addShare() {
  const user = recipient.value
  if (!user) return
  remember(user)
  const ok = await run(
    () => calshare.share(props.calendar.id, user.id, permission.value),
    $gettext('Could not share the calendar')
  )
  if (ok) {
    showMessage({
      title: $gettext('"%{calendar}" is now shared with %{name}', {
        calendar: props.calendar.displayName,
        name: user.displayName
      })
    })
    recipient.value = null
    permission.value = 'read'
  }
}

function changePermission(share: Share, value: Permission) {
  if (value === share.permission) return
  return run(
    () => calshare.share(props.calendar.id, share.user.id, value),
    $gettext('Could not change the permission')
  )
}

function removeShare(share: Share) {
  return run(
    () => calshare.unshare(props.calendar.id, share.user.id),
    $gettext('Could not stop sharing')
  )
}
</script>
