// The Accept link put in an invitation copy (what a CalDAV client shows) answers the invitation.
// usage: [BROWSER=firefox] TOKENS_FILE=tokens.env node test/ui-respond.mjs <screenshot dir>
import { browserType, launchOptions } from './browser.mjs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const out = process.argv[2] ?? '.'
const OC = process.env.OC ?? 'https://localhost:9200'
const tokens = readFileSync(process.env.TOKENS_FILE ?? 'tokens.env', 'utf8')
const auth = (who) => 'Basic ' + Buffer.from(`${who}:${tokens.match(new RegExp(`^${who}=(.*)$`, 'm'))[1]}`).toString('base64')
const ALICE = 'be578ae3-5d68-4ad0-9cb2-0e0c9123e76d'
const BOB = '4fbd8358-64a7-419a-87a7-61485582660e'
const EV = `respond-${Date.now()}.ics`
const call = (who, method, path, body, headers = {}) =>
  fetch(OC + path, { method, body, headers: { Authorization: auth(who), ...headers } })
const unfold = (ics) => ics.replace(/\r/g, '').replace(/\n /g, '').replace(/\\n/g, '\n') // unfold, then unescape TEXT newlines
const bobCopy = async () => unfold(await (await call('bob', 'GET', `/caldav/${BOB}/def-calendar/${EV}`)).text())

// alice invites bob
const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VEVENT', `UID:${EV}`, 'DTSTAMP:20261017T080000Z',
  'DTSTART;TZID=Europe/Paris:20261027T140000', 'DTEND;TZID=Europe/Paris:20261027T150000', 'SUMMARY:Revue trimestrielle',
  'DESCRIPTION:Chiffres Q3 et budget Q4', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
console.log('create:', (await call('alice', 'PUT', `/caldav/${ALICE}/def-calendar/${EV}`, ics, { 'Content-Type': 'text/calendar' })).status)
console.log('invite:', (await call('alice', 'PUT', `/calshare/v1/calendars/def-calendar/events/${EV}/guests`, '{"guests":["bob"]}', { 'Content-Type': 'application/json' })).status)
await new Promise((r) => setTimeout(r, 2500))

let copy = await bobCopy()
console.log('bob sees in his CalDAV client:', copy.match(/^SUMMARY:.*$/m)?.[0], '|', copy.match(/^STATUS:.*$/m)?.[0])
const accept = copy.match(/Accepter : (\S+)/)?.[1].replace(/\\,/g, ',').replace(/\\;/g, ';')
console.log('accept link:', accept)

// bob clicks the link
// Persistent context: lets us open a tab directly on a URL (CDP Target.createTarget), like a link
// clicked in a calendar app — Playwright's newPage() would add an about:blank history entry.
const profile = mkdtempSync(join(tmpdir(), 'ui-respond-'))
const context = await browserType.launchPersistentContext(profile, { ...launchOptions,
  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 }, colorScheme: 'light', locale: 'fr-FR', timezoneId: 'Europe/Paris' })
const page = context.pages()[0] ?? await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(accept, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('input[type=password]')
await page.locator('input:not([type=password]):not([type=hidden])').first().fill('bob')
await page.locator('input[type=password]').fill('Test-bob-12345')
await page.keyboard.press('Enter')
await page.waitForSelector('.saved', { timeout: 30000 })
console.log('page says:', (await page.locator('.saved').textContent()).trim())
console.log('url after:', page.url().replace(OC, ''))
await page.screenshot({ path: `${out}/respond-1-accepted.png` })
// after login redirects the browser refuses window.close(): the page must say so
await page.waitForTimeout(4500)
console.log('after login, page closed itself:', page.isClosed(),
  page.isClosed() ? '' : `| shows: ${(await page.locator('.saved').textContent()).replace(/\s+/g, ' ').trim()}`)

await new Promise((r) => setTimeout(r, 2500))
copy = await bobCopy()
console.log('bob\'s client after the click:', copy.match(/^SUMMARY:.*$/m)?.[0], '|', copy.match(/^STATUS:.*$/m)?.[0] ?? '(no STATUS)')
const guests = await (await call('alice', 'GET', `/calshare/v1/calendars/def-calendar/events/${EV}/guests`)).json()
console.log('alice sees:', guests.guests.map((g) => `${g.displayName}=${g.response}`).join(', '))

// already logged in, link opened in a new tab (what clicking it in a calendar app does): the tab closes itself
const maybe = accept.replace('response=accepted', 'response=tentative')
const opened = context.waitForEvent('page')
await (await context.newCDPSession(page)).send('Target.createTarget', { url: maybe })
const tab = await opened
const closed = tab.waitForEvent('close', { timeout: 20000 }).then(() => true).catch(() => false)
await tab.waitForSelector('.saved', { timeout: 30000 }).catch(() => {})
console.log('countdown shown:', !tab.isClosed() && (await tab.locator('.saved').textContent().catch(() => '')).includes('se fermer'))
console.log('new tab closed itself after answering:', await closed)
await new Promise((r) => setTimeout(r, 2500))
console.log('alice sees after tentative:', (await (await call('alice', 'GET', `/calshare/v1/calendars/def-calendar/events/${EV}/guests`)).json()).guests.map((g) => `${g.displayName}=${g.response}`).join(', '))

// a link that is not for you
await page.goto(`${OC}/calendar/respond?cal=def-calendar&event=nope.ics&response=accepted`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.oc-notification-message', { timeout: 20000 })
console.log('bogus link:', (await page.locator('.oc-notification-message').textContent()).replace(/\s+/g, ' ').trim().slice(0, 60))
await page.screenshot({ path: `${out}/respond-2-not-found.png` })

await call('alice', 'DELETE', `/caldav/${ALICE}/def-calendar/${EV}`)
console.log(errors.join('\n') || '(no page errors)')
await context.close()
rmSync(profile, { recursive: true, force: true })
