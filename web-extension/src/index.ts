import '@opencloud-eu/extension-sdk/tailwind.css'
import {
  AppMenuItemExtension,
  ApplicationInformation,
  CustomComponentExtension,
  defineWebApplication,
  useUserStore
} from '@opencloud-eu/web-pkg'
import { urlJoin } from '@opencloud-eu/web-client'
import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import translations from '../l10n/translations.json'
import CalendarView from './views/CalendarView.vue'
import CalendarSharing from './views/CalendarSharing.vue'
import RespondView from './views/RespondView.vue'
import InvitationsBell from './components/InvitationsBell.vue'
import { startInvitationsFeed } from './invitationsFeed'

// Must not be "caldav" or "calshare": the proxy sends those paths to Radicale and its sidecar.
const applicationId = 'calendar'

// App icon: the repo icon (docs/assets/icon.svg) drawn as a one-color glyph like OpenCloud's own app
// icons, on the theme's secondary tile like Files. OpenCloud 8.1 only takes icon names, resolved as
// <base>icons/<name>-fill.svg, so the name points back to public/img/app-fill.svg under
// <base>assets/apps/calendar/.
const appIcon = `../assets/apps/${applicationId}/img/app`
const appIconColor = 'var(--oc-role-secondary)'

export default defineWebApplication({
  setup() {
    const { $gettext } = useGettext()
    const userStore = useUserStore()
    // Runs at OpenCloud Web startup: invitations are noticed whatever app is open.
    startInvitationsFeed()

    const routes = [
      {
        name: `${applicationId}-main`,
        path: '/',
        component: CalendarView,
        meta: { authContext: 'user', title: $gettext('Calendar'), patchCleanPath: true }
      },
      {
        // Target of the Accept / Maybe / Decline links put in invitation copies
        name: `${applicationId}-respond`,
        path: '/respond',
        component: RespondView,
        meta: { authContext: 'user', title: $gettext('Invitation'), patchCleanPath: true }
      },
      {
        name: `${applicationId}-sharing`,
        path: '/sharing',
        component: CalendarSharing,
        meta: { authContext: 'user', title: $gettext('Calendar sharing'), patchCleanPath: true }
      }
    ]

    const appInfo: ApplicationInformation = {
      name: $gettext('Calendar'),
      id: applicationId,
      icon: appIcon,
      iconFillType: 'fill',
      iconColor: appIconColor
    }

    const extensions = computed<(AppMenuItemExtension | CustomComponentExtension)[]>(() => {
      if (!userStore.user) return []
      return [
        {
          // calendar bell next to OpenCloud's notification bell (shown when invitations await an answer)
          id: `app.${applicationId}.invitations-bell`,
          type: 'customComponent',
          extensionPointIds: ['app.runtime.header.right'],
          content: InvitationsBell
        },
        {
          id: `app.${applicationId}.menuItem`,
          type: 'appMenuItem',
          label: () => 'WebCalendar',
          icon: appIcon,
          color: appIconColor,
          path: urlJoin(applicationId)
        }
      ]
    })

    return { appInfo, routes, translations, extensions }
  }
})
