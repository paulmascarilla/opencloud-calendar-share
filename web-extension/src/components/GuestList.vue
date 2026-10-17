<template>
  <section class="ext:flex ext:flex-col ext:gap-2">
    <h3 class="ext:m-0 ext:text-sm ext:font-semibold">
      {{ $gettext('Guests') }}
      <span v-if="summary" class="ext:font-normal ext:text-role-on-surface-variant">· {{ summary }}</span>
    </h3>

    <p v-if="organizer" class="ext:m-0 ext:text-sm ext:text-role-on-surface-variant">
      {{ $gettext('Organized by %{name}', { name: organizer.name }) }}
    </p>

    <user-picker v-if="editable" v-model="picked" :exclude-ids="excluded" />

    <ul v-if="guests.length" class="ext:list-none ext:m-0 ext:p-0 ext:flex ext:flex-col ext:gap-1">
      <li v-for="guest in guests" :key="guest.id" class="ext:flex ext:items-center ext:gap-2 ext:py-1">
        <oc-avatar :user-name="guest.name" :width="28" />
        <span class="ext:flex-1 ext:min-w-0 ext:truncate ext:text-sm">
          {{ guest.name }}<span v-if="guest.id === meId" class="ext:text-role-on-surface-variant">
            ({{ $gettext('you') }})</span
          >
        </span>
        <span
          class="response ext:inline-flex ext:items-center ext:gap-1 ext:text-xs"
          :class="`response-${guest.response}`"
        >
          <oc-icon :name="RESPONSE_ICONS[guest.response]" size="xsmall" />
          {{ responseLabel(guest.response) }}
        </span>
        <oc-button
          v-if="editable"
          appearance="raw"
          size="small"
          :aria-label="$gettext('Remove %{name}', { name: guest.name })"
          @click="emit('update:guests', guests.filter((g) => g.id !== guest.id))"
        >
          <oc-icon name="close" size="small" />
        </oc-button>
      </li>
    </ul>
    <p v-else-if="!editable" class="ext:m-0 ext:text-sm ext:text-role-on-surface-variant">
      {{ $gettext('No guests') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useGettext } from 'vue3-gettext'
import type { Guest, GuestResponse, Person } from '../ical'
import type { DirectoryUser } from '../composables/useUserDirectory'
import UserPicker from './UserPicker.vue'

const props = defineProps<{
  guests: Guest[]
  organizer: Person | null
  editable: boolean
  meId: string
}>()
const emit = defineEmits<{ (e: 'update:guests', value: Guest[]): void }>()

const { $gettext } = useGettext()
const picked = ref<DirectoryUser | null>(null)

const RESPONSE_ICONS: Record<GuestResponse, string> = {
  pending: 'time',
  accepted: 'checkbox-circle',
  tentative: 'question',
  declined: 'close-circle'
}

const excluded = computed(() => [props.meId, props.organizer?.id ?? '', ...props.guests.map((g) => g.id)])

const summary = computed(() => {
  if (!props.guests.length) return ''
  const yes = props.guests.filter((g) => g.response === 'accepted').length
  return $gettext('%{yes} of %{total} accepted', { yes: String(yes), total: String(props.guests.length) })
})

watch(picked, (user) => {
  if (!user) return
  emit('update:guests', [...props.guests, { id: user.id, name: user.displayName, response: 'pending' }])
  picked.value = null
})

function responseLabel(response: GuestResponse) {
  return {
    pending: $gettext('Awaiting answer'),
    accepted: $gettext('Accepted'),
    tentative: $gettext('Maybe'),
    declined: $gettext('Declined')
  }[response]
}
</script>

<style scoped>
.response {
  color: var(--oc-role-on-surface-variant);
}
.response-accepted {
  color: var(--oc-role-primary);
}
.response-declined {
  color: var(--oc-role-error);
}
</style>
