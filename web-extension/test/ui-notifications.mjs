// Invitations bell + toast in OpenCloud's top bar (while another app is open), refresh button, calendar creation.
// usage: [BROWSER=firefox] TOKENS_FILE=tokens.env node test/ui-notifications.mjs <screenshot dir>
import { launch } from './browser.mjs'
import { readFileSync } from 'node:fs'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const out = process.argv[2] ?? '.'
const OC = process.env.OC ?? 'https://localhost:9200'
const tokens = readFileSync(process.env.TOKENS_FILE ?? 'tokens.env', 'utf8')
const auth = (who) => 'Basic ' + Buffer.from(`${who}:${tokens.match(new RegExp(`^${who}=(.*)$`, 'm'))[1]}`).toString('base64')
const call = (who, method, path, body, headers = {}) => fetch(OC + path, { method, body, headers: { Authorization: auth(who), ...headers } })
const ALICE = 'be578ae3-5d68-4ad0-9cb2-0e0c9123e76d'
const EV = `notif-${Date.now()}.ics`
const browser = await launch()
const errors = []

async function login(user, pass, path, scheme = 'dark') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, colorScheme: scheme, locale: 'fr-FR', timezoneId: 'Europe/Paris' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`))
  await page.goto(OC + path, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=password]')
  await page.locator('input:not([type=password]):not([type=hidden])').first().fill(user)
  await page.locator('input[type=password]').fill(pass)
  await page.keyboard.press('Enter')
  return page
}

// 1. bob works in the Files app
const bob = await login('bob', 'Test-bob-12345', '/files')
await bob.waitForSelector('#oc-notifications-bell, .files-list, #files', { timeout: 30000 }).catch(() => {})
await bob.waitForTimeout(4000) // first feed run: existing invitations are remembered without notifying
console.log('bell before invitation:', await bob.locator('#oc-calendar-invitations-bell').count())

// 2. alice invites him
const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VEVENT', `UID:${EV}`, 'DTSTAMP:20261017T080000Z',
  'DTSTART;TZID=Europe/Paris:20261028T100000', 'DTEND;TZID=Europe/Paris:20261028T110000', 'SUMMARY:Atelier roadmap', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
await call('alice', 'PUT', `/caldav/${ALICE}/def-calendar/${EV}`, ics, { 'Content-Type': 'text/calendar' })
await call('alice', 'PUT', `/calshare/v1/calendars/def-calendar/events/${EV}/guests`, '{"guests":["bob"]}', { 'Content-Type': 'application/json' })
const t0 = Date.now()
await bob.locator('#oc-calendar-invitations-bell').waitFor({ timeout: 45000 })
console.log(`bell appeared in Files after ${((Date.now() - t0) / 1000).toFixed(0)}s, badge:`, await bob.locator('#oc-calendar-invitations-bell .badge').textContent())
console.log('toast:', (await bob.getByText('Nouvelle invitation').first().isVisible().catch(() => false)) ? 'Nouvelle invitation ✓' : 'missing')
await bob.screenshot({ path: `${out}/n1-topbar-files.png`, clip: { x: 700, y: 0, width: 740, height: 140 } })
await bob.locator('#oc-calendar-invitations-bell').click()
await bob.waitForSelector('#oc-calendar-invitations-drop li', { timeout: 5000 })
await bob.waitForTimeout(400)
console.log('drop:', (await bob.locator('#oc-calendar-invitations-drop li').first().textContent()).replace(/\s+/g, ' ').trim())
await bob.screenshot({ path: `${out}/n2-drop.png` })

// 3. the calendar shows the status mark
const cal = await bob.context().newPage()
await cal.goto(`${OC}/calendar?date=2026-10-28`, { waitUntil: 'domcontentloaded' })
await cal.waitForSelector('.oc-ev', { timeout: 30000 }); await cal.waitForTimeout(1500)
console.log('calendar title:', await cal.locator('.oc-ev-invitation .oc-ev-title, .oc-ev-invitation .fc-event-title').first().textContent())
console.log('breadcrumb present:', await cal.locator('.oc-breadcrumb').count())

// 4. accept from the bell
await bob.locator('#oc-calendar-invitations-drop').getByRole('button', { name: 'Accepter' }).first().click()
await bob.waitForTimeout(2500)
console.log('bell after accepting:', await bob.locator('#oc-calendar-invitations-bell').count())
const g = await (await call('alice', 'GET', `/calshare/v1/calendars/def-calendar/events/${EV}/guests`)).json()
console.log('alice sees:', g.guests.map((x) => `${x.displayName}=${x.response}`).join(', '))
await cal.waitForTimeout(3000)
await cal.getByRole('button', { name: 'Actualiser maintenant' }).click(); await cal.waitForTimeout(1500)
console.log('calendar title after accept:', await cal.locator('.oc-ev-invitation .oc-ev-title').first().textContent())

// 5. refresh button keeps its look after a click (mouse moved away)
await cal.mouse.move(5, 600); await cal.waitForTimeout(300)
console.log('refresh button bg after click:', await cal.getByRole('button', { name: 'Actualiser maintenant' }).evaluate((el) => getComputedStyle(el).backgroundColor))

// 6. create a calendar
await cal.getByRole('button', { name: 'Nouvel agenda' }).click()
await cal.locator('#calendar-name').fill('Projets perso')
await cal.getByRole('radio', { name: 'Orange' }).click()
await cal.screenshot({ path: `${out}/n3-new-calendar.png` })
await cal.getByRole('button', { name: 'Créer' }).click()
await cal.locator('aside', { hasText: 'Projets perso' }).waitFor({ timeout: 15000 })
console.log('sidebar after create:', (await cal.locator('aside li').allTextContents()).map((t) => t.trim()).join(' | '))
await cal.screenshot({ path: `${out}/n4-sidebar.png` })

// cleanup
const home = await (await call('bob', 'PROPFIND', '/caldav/4fbd8358-64a7-419a-87a7-61485582660e/', '', { Depth: '1' })).text()
for (const m of home.matchAll(/<href>([^<]*\/cal-[0-9a-f]{8}\/)<\/href>/g)) console.log('cleanup calendar', m[1], (await call('bob', 'DELETE', m[1])).status)
await call('alice', 'DELETE', `/caldav/${ALICE}/def-calendar/${EV}`)
console.log(errors.join('\n') || '(no page errors)')
await browser.close()
