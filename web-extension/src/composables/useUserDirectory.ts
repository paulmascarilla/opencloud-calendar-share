import { useClientService } from '@opencloud-eu/web-pkg'
import { reactive } from 'vue'

export interface DirectoryUser {
  id: string
  displayName: string
  username?: string
}

// Shared across components so each id is looked up at most once per page load.
const names = reactive<Record<string, DirectoryUser>>({})
const pending = new Map<string, Promise<void>>()

/** Searches OpenCloud users and resolves user ids to display names via the Graph API. */
export function useUserDirectory() {
  const clientService = useClientService()

  async function search(query: string): Promise<DirectoryUser[]> {
    // OpenCloud rejects shorter terms for non-admin users ("search term too short").
    if (query.trim().length < 3) {
      return []
    }
    // Graph needs the term quoted, otherwise e-mail addresses are rejected.
    const users = await clientService.graphAuthenticated.users.listUsers({
      search: `"${query.trim().replace(/"/g, '')}"`,
      orderBy: ['displayName']
    })
    return users.map((u) => remember({ id: u.id, displayName: u.displayName, username: u.onPremisesSamAccountName }))
  }

  function remember(user: DirectoryUser) {
    names[user.id] = user
    return user
  }

  function resolve(id: string) {
    if (names[id] || pending.has(id)) {
      return
    }
    const lookup = clientService.graphAuthenticated.users
      .getUser(id, { select: ['id', 'displayName', 'onPremisesSamAccountName'] })
      .then((u) => {
        remember({ id: u.id, displayName: u.displayName, username: u.onPremisesSamAccountName })
      })
      .catch(() => {
        remember({ id, displayName: id })
      })
    pending.set(id, lookup)
  }

  function displayName(id: string) {
    resolve(id)
    return names[id]?.displayName ?? '…'
  }

  return { search, remember, displayName }
}
