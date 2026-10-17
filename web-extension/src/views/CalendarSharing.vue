<template>
  <div class="ext:flex ext:flex-col ext:h-full">
    <header
      class="ext:flex ext:items-center ext:justify-between ext:gap-3 ext:px-5 ext:py-4 ext:border-b ext:border-role-outline-variant ext:bg-role-surface-container"
    >
      <h1 class="ext:m-0 ext:text-xl ext:font-semibold ext:flex ext:items-center ext:min-w-0">
        <router-link
          :to="{ name: 'calendar-main' }"
          class="ext:no-underline ext:opacity-60 ext:hover:opacity-100"
          >{{ $gettext('Calendar') }}</router-link
        >
        <span class="ext:mx-2 ext:opacity-40">/</span>
        {{ $gettext('Calendar sharing') }}
      </h1>
      <oc-button appearance="raw" size="small" :disabled="loading" @click="load">
        <oc-icon name="refresh" size="small" />
        {{ $gettext('Refresh') }}
      </oc-button>
    </header>

    <div class="ext:flex-1 ext:overflow-y-auto ext:p-5">
      <div class="ext:max-w-4xl ext:mx-auto ext:flex ext:flex-col ext:gap-8">
        <div v-if="loading && !loaded" class="ext:flex ext:justify-center ext:py-12">
          <oc-spinner size="medium" :aria-label="$gettext('Loading calendars')" />
        </div>

        <oc-notification-message
          v-else-if="loadError"
          status="danger"
          :title="$gettext('Calendar sharing is unavailable')"
          :message="loadError"
        />

        <template v-else>
          <section>
            <h2 class="ext:text-lg ext:font-semibold ext:mb-1">{{ $gettext('My calendars') }}</h2>
            <p class="ext:mt-0 ext:mb-4 ext:text-sm ext:text-role-on-surface-variant">
              {{
                $gettext(
                  'People you share a calendar with see it automatically in their calendar apps.'
                )
              }}
            </p>
            <p v-if="!calendars.length" class="ext:text-role-on-surface-variant">
              {{
                $gettext(
                  'You have no calendar yet. Connect a calendar app once with the address below to create it.'
                )
              }}
            </p>
            <div class="ext:flex ext:flex-col ext:gap-4">
              <calendar-card
                v-for="calendar in calendars"
                :key="calendar.id"
                :calendar="calendar"
                :owner-id="userId"
                :shares="outgoing.filter((s) => s.calendar === calendar.id)"
                @changed="load"
              />
            </div>
          </section>

          <section>
            <h2 class="ext:text-lg ext:font-semibold ext:mb-1">{{ $gettext('Shared with me') }}</h2>
            <p class="ext:mt-0 ext:mb-4 ext:text-sm ext:text-role-on-surface-variant">
              {{ $gettext('Calendars other people share with you.') }}
            </p>
            <p v-if="!incoming.length" class="ext:text-role-on-surface-variant">
              {{ $gettext('Nobody has shared a calendar with you yet.') }}
            </p>
            <ul class="ext:list-none ext:m-0 ext:p-0 ext:flex ext:flex-col ext:gap-2">
              <incoming-share
                v-for="share in incoming"
                :key="share.mount"
                :share="share"
                @changed="load"
              />
            </ul>
          </section>

          <section
            class="ext:rounded-lg ext:p-4 ext:bg-role-surface-container-low ext:border ext:border-role-outline-variant"
          >
            <h2 class="ext:text-base ext:font-semibold ext:mt-0 ext:mb-1">
              {{ $gettext('Connect a calendar app') }}
            </h2>
            <p class="ext:mt-0 ext:mb-3 ext:text-sm ext:text-role-on-surface-variant">
              {{
                $gettext(
                  'Use this CalDAV address in Thunderbird, DAVx⁵, Apple Calendar… Shared calendars are included.'
                )
              }}
            </p>
            <div class="ext:flex ext:items-center ext:gap-2">
              <code
                class="ext:flex-1 ext:min-w-0 ext:truncate ext:px-3 ext:py-2 ext:rounded ext:bg-role-surface ext:border ext:border-role-outline-variant ext:text-sm"
                >{{ caldavUrl }}</code
              >
              <oc-button appearance="outline" size="small" @click="copyCaldavUrl">
                <oc-icon name="file-copy" size="small" />
                {{ $gettext('Copy') }}
              </oc-button>
            </div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, unref } from 'vue'
import { useConfigStore, useMessages, useUserStore } from '@opencloud-eu/web-pkg'
import { urlJoin } from '@opencloud-eu/web-client'
import { useGettext } from 'vue3-gettext'
import { apiErrorMessage, Calendar, Share, useCalshare } from '../composables/useCalshare'
import CalendarCard from '../components/CalendarCard.vue'
import IncomingShare from '../components/IncomingShare.vue'

const { $gettext } = useGettext()
const { showMessage } = useMessages()
const userStore = useUserStore()
const configStore = useConfigStore()
const calshare = useCalshare()

const calendars = ref<Calendar[]>([])
const outgoing = ref<Share[]>([])
const incoming = ref<Share[]>([])
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')

const userId = computed(() => userStore.user?.id ?? '')
const caldavUrl = computed(() => urlJoin(unref(configStore.serverUrl), 'caldav', unref(userId)) + '/')

async function load() {
  loading.value = true
  try {
    const [c, o, i] = await Promise.all([
      calshare.listCalendars(),
      calshare.listOutgoing(),
      calshare.listIncoming()
    ])
    calendars.value = c
    outgoing.value = o
    incoming.value = i
    loadError.value = ''
  } catch (error) {
    loadError.value = apiErrorMessage(error) ?? (error as Error).message
  } finally {
    loading.value = false
    loaded.value = true
  }
}

async function copyCaldavUrl() {
  await navigator.clipboard.writeText(unref(caldavUrl))
  showMessage({ title: $gettext('CalDAV address copied') })
}

onMounted(load)
</script>
