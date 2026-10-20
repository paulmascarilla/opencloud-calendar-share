<template>
  <div v-if="pending.length" class="ext:flex">
    <!-- same look as OpenCloud's notification bell, right next to it -->
    <oc-button
      id="oc-calendar-invitations-bell"
      v-oc-tooltip="label"
      class="ext:relative"
      appearance="raw-inverse"
      color-role="chrome"
      :aria-label="label"
      no-hover
    >
      <oc-icon name="calendar-event" fill-type="line" class="ext:cursor-pointer ext:flex ext:items-center" />
      <span class="badge" aria-hidden="true">{{ pending.length > 99 ? '99+' : pending.length }}</span>
    </oc-button>
    <oc-drop
      drop-id="oc-calendar-invitations-drop"
      toggle="#oc-calendar-invitations-bell"
      mode="click"
      :title="$gettext('Invitations awaiting your answer')"
      padding-size="small"
      :is-menu="false"
      class="ext:w-md ext:max-w-full ext:max-h-[420px] ext:overflow-y-auto"
      :options="{ pos: 'bottom-right', delayHide: 0 }"
    >
      <ul class="ext:list-none ext:m-0 ext:p-0 ext:flex ext:flex-col">
        <li
          v-for="(invitation, index) in pending"
          :key="`${invitation.calendar}/${invitation.event}`"
          class="ext:py-2"
          :class="{ 'ext:border-t ext:border-role-outline-variant': index > 0 }"
        >
          <router-link
            :to="{ name: 'calendar-respond', query: { cal: invitation.calendar, event: invitation.event } }"
            class="ext:block ext:no-underline ext:text-role-on-surface"
          >
            <span class="ext:flex ext:items-center ext:font-semibold ext:truncate">
              <span class="oc-puce" aria-hidden="true" />{{ invitation.title || $gettext('(no title)') }}
            </span>
            <span class="ext:block ext:text-sm ext:text-role-on-surface-variant">
              {{ when(invitation) }}<template v-if="invitation.organizer"> · {{ invitation.organizer }}</template>
            </span>
          </router-link>
          <div class="ext:flex ext:gap-2 ext:mt-2">
            <oc-button size="small" appearance="filled" :disabled="busy" @click="answer(invitation, 'accepted')">
              <oc-icon name="check" size="small" /> {{ $gettext('Accept') }}
            </oc-button>
            <oc-button size="small" appearance="outline" :disabled="busy" @click="answer(invitation, 'tentative')">
              {{ $gettext('Maybe') }}
            </oc-button>
            <oc-button size="small" appearance="outline" :disabled="busy" @click="answer(invitation, 'declined')">
              {{ $gettext('Decline') }}
            </oc-button>
          </div>
        </li>
      </ul>
      <div
        class="ext:flex ext:flex-wrap ext:justify-between ext:gap-2 ext:pt-2 ext:mt-1 ext:border-t ext:border-role-outline-variant"
      >
        <oc-button type="router-link" :to="{ name: 'calendar-main' }" appearance="raw" size="small">
          {{ $gettext('Open the calendar') }}
        </oc-button>
        <oc-button
          v-if="desktopPermission === 'default'"
          appearance="raw"
          size="small"
          @click="enableDesktopNotifications"
        >
          <oc-icon name="notification-3" size="small" /> {{ $gettext('Enable desktop notifications') }}
        </oc-button>
      </div>
    </oc-drop>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMessages } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { apiErrorMessage, PendingInvitation, useCalshare } from '../composables/useCalshare'
import { useInvitationsFeed } from '../invitationsFeed'
import '../calendar.css'

const { $gettext, $ngettext, current } = useGettext()
const { showMessage, showErrorMessage } = useMessages()
const calshare = useCalshare()
const { pending, desktopPermission, refresh, enableDesktopNotifications } = useInvitationsFeed()
const busy = ref(false)

const label = computed(() =>
  $ngettext('%{n} invitation awaiting your answer', '%{n} invitations awaiting your answer', pending.value.length, {
    n: String(pending.value.length)
  })
)

function when(invitation: PendingInvitation) {
  if (!invitation.start) return ''
  const start = new Date(invitation.start)
  const options: Intl.DateTimeFormatOptions = invitation.allDay
    ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }
    : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
  const text = new Intl.DateTimeFormat(current, options).format(start)
  return invitation.recurring ? $gettext('Recurring, from %{when}', { when: text }) : text
}

async function answer(invitation: PendingInvitation, response: 'accepted' | 'tentative' | 'declined') {
  busy.value = true
  try {
    await calshare.answerInvitation(invitation.calendar, invitation.event, response)
    showMessage({
      title: {
        accepted: $gettext('You accepted the invitation'),
        tentative: $gettext('You answered maybe'),
        declined: $gettext('You declined the invitation')
      }[response],
      desc: invitation.title
    })
    await refresh()
  } catch (error) {
    showErrorMessage({ title: $gettext('Could not send your answer'), desc: apiErrorMessage(error), errors: [error as Error] })
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
/* same badge as OpenCloud's notification bell */
.badge {
  position: absolute;
  top: -6px;
  right: -9px;
  padding: 0.25rem;
  min-width: 0.5rem;
  height: 0.5rem;
  box-sizing: content-box;
  border-radius: 2rem;
  background: #dc2626;
  color: #fff;
  font-size: 0.75rem;
  line-height: 0.5rem;
  text-align: center;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
}
</style>
