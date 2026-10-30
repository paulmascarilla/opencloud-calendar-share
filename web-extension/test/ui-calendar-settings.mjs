// Calendar settings in a real (headless) browser: rename and recolor a shared calendar (the recipient sees it),
// the default calendar cannot be deleted, delete a shared calendar, a recipient removes a calendar from their list.
// Needs alice and bob (Test-<user>-12345); creates its own calendars through the API.
// usage: [BROWSER=firefox] OC=https://localhost:9200 node test/ui-calendar-settings.mjs <screenshot dir>
import { launch } from './browser.mjs'
const [out] = process.argv.slice(2)
const OC = process.env.OC ?? 'https://localhost:9200'
const pass = (user) => `Test-${user}-12345`
const auth = (user) => ({ Authorization: 'Basic ' + Buffer.from(`${user}:${pass(user)}`).toString('base64') })
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

async function api(user, method, path, body) {
  const r = await fetch(OC + path, {
    method,
    headers: { ...auth(user), ...(body && !body.startsWith('<') ? { 'Content-Type': 'application/json' } : {}) },
    body
  })
  return { status: r.status, text: await r.text() }
}
const me = async (user) => JSON.parse((await api(user, 'GET', '/graph/v1.0/me')).text).id
const mkcalendar = async (user, id, name) => {
  await api(user, 'PROPFIND', '/caldav/')
  const href = `/caldav/${await me(user)}/${id}/`
  await api(user, 'DELETE', href)
  return api(user, 'MKCALENDAR', href, `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/"><D:set><D:prop><D:displayname>${name}</D:displayname><I:calendar-color>#2e8b57</I:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`)
}

let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'KO  '} ${name}`); if (!ok) failures++ }

await api('bob', 'PROPFIND', '/caldav/')
await mkcalendar('alice', 'ui-settings', 'Settings test')
await mkcalendar('alice', 'ui-leave', 'Leave test')
for (const cal of ['ui-settings', 'ui-leave']) await api('alice', 'PUT', `/calshare/v1/calendars/${cal}/shares/bob`, '{"permission":"read"}')

const browser = await launch()
async function open(user) {
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 860 }, locale: 'en-US' })
  page.on('pageerror', (e) => console.log(`[pageerror ${user}] ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/calshare/')) console.log(`[http ${r.status()}] ${r.request().method()} ${r.url()}`) })
  await page.goto(`${OC}/calendar`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=password], aside', { timeout: 30000 })
  if (await page.locator('input[type=password]').count()) {
    await page.locator('input:not([type=password]):not([type=hidden])').first().fill(user)
    await page.locator('input[type=password]').fill(pass(user))
    await page.keyboard.press('Enter')
  }
  await page.waitForSelector('aside nav', { timeout: 30000 })
  await page.waitForTimeout(2000)
  return page
}
const sidebar = (page) => page.locator('aside nav').innerText()
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` })

// alice renames and recolors
const alice = await open('alice')
await alice.getByRole('button', { name: 'Settings of Settings test' }).click()
await alice.waitForSelector('#calendar-settings-name')
await shot(alice, 'settings-1-dialog')
check('dialog says who sees the change', (await alice.locator('.oc-modal').innerText()).includes('Shared with 1 person'))
await alice.locator('#calendar-settings-name').fill('Renamed calendar')
await alice.getByRole('radio', { name: 'Teal' }).click()
await alice.getByRole('button', { name: 'Save' }).click()
await alice.waitForTimeout(2500)
await shot(alice, 'settings-2-renamed')
check('alice sees the new name', (await sidebar(alice)).includes('Renamed calendar'))

const bob = await open('bob')
await shot(bob, 'settings-3-bob-sees-rename')
const bobSide = await sidebar(bob)
check('bob sees the new name', bobSide.includes('Renamed calendar (Alice)'))
const bobColor = await bob.locator('label', { hasText: 'Renamed calendar' }).locator('input.swatch').evaluate((el) => getComputedStyle(el).borderColor)
check(`bob sees the new color (${bobColor})`, bobColor === 'rgb(0, 128, 128)')

// the default calendar cannot be deleted
// def-calendar is named "Calendar" when OpenCloud provisions it
await alice.getByRole('button', { name: 'Settings of Calendar', exact: true }).click()
await alice.waitForSelector('#calendar-settings-name')
check('delete disabled for the default calendar', await alice.getByRole('button', { name: 'Delete calendar' }).isDisabled())
await alice.getByRole('button', { name: 'Cancel' }).click()

// alice deletes the shared calendar
await alice.getByRole('button', { name: 'Settings of Renamed calendar' }).click()
await alice.getByRole('button', { name: 'Delete calendar' }).click()
await alice.waitForTimeout(500)
await shot(alice, 'settings-4-confirm-delete')
check('confirmation names who loses access', (await alice.locator('.oc-modal').innerText()).includes('Bob loses access'))
await alice.locator('.oc-modal').getByRole('button', { name: 'Delete calendar' }).click()
await alice.waitForTimeout(2500)
await shot(alice, 'settings-5-deleted')
check('alice no longer has it', !(await sidebar(alice)).includes('Renamed calendar'))
await bob.reload({ waitUntil: 'domcontentloaded' })
await bob.waitForSelector('aside nav'); await bob.waitForTimeout(2000)
check('bob no longer has it', !(await sidebar(bob)).includes('Renamed calendar'))

// bob removes a calendar shared with him
await bob.getByRole('button', { name: 'Remove Leave test (Alice) from my calendars' }).click()
await bob.waitForTimeout(2500)
await shot(bob, 'settings-6-bob-left')
check('bob removed it from his list', !(await sidebar(bob)).includes('Leave test'))
const incoming = JSON.parse((await api('bob', 'GET', '/calshare/v1/shared-with-me')).text)
check('it can be accepted again (declined share kept)', incoming.some((s) => s.calendar === 'ui-leave' && !s.accepted))

await api('alice', 'DELETE', '/calshare/v1/calendars/ui-leave')
await browser.close()
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
