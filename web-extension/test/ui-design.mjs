// Visual check (light/dark screenshots) + auto refresh: an event created through CalDAV must appear without reload.
// usage: CHROMIUM=/snap/bin/chromium TOKENS_FILE=tokens.env node test/ui-design.mjs <screenshot dir>
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const out = process.argv[2]
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/snap/bin/chromium', headless: true })
const errors = []
async function open(scheme) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, colorScheme: scheme, timezoneId: 'Europe/Paris', locale: 'fr-FR' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${scheme}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/photo/')) errors.push(`${scheme}: HTTP ${r.status()} ${r.url()}`) })
  await page.goto('https://localhost:9200/calendar', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=password]')
  await page.locator('input:not([type=password]):not([type=hidden])').first().fill('alice')
  await page.locator('input[type=password]').fill('Test-alice-12345')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.fc-timegrid', { timeout: 30000 })
  return page
}
const dark = await open('dark')
// theme follows OpenCloud's own setting, not only the OS: force light/dark through the html class if any
await dark.getByRole('button', { name: 'Suivant' }).click()
await dark.waitForSelector('.oc-ev', { timeout: 15000 })
await dark.waitForTimeout(1500)
await dark.screenshot({ path: `${out}/d1-week.png` })
console.log('header:', (await dark.locator('.oc-calendar header h2').textContent()), '|', await dark.locator('.oc-calendar header p').textContent())

// auto refresh: create an event behind the page's back
const before = await dark.locator('.oc-ev', { hasText: 'Ajouté par API' }).count()
{
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const token = readFileSync(process.env.TOKENS_FILE ?? 'tokens.env', 'utf8').match(/^alice=(.*)$/m)[1]
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//demo//EN', 'BEGIN:VEVENT', 'UID:demo-api', 'DTSTAMP:20261017T080000Z',
    'DTSTART;TZID=Europe/Paris:20261022T150000', 'DTEND;TZID=Europe/Paris:20261022T160000', 'SUMMARY:Ajouté par API', 'COLOR:crimson',
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
  const r = await fetch('https://localhost:9200/caldav/be578ae3-5d68-4ad0-9cb2-0e0c9123e76d/def-calendar/demo-api.ics', {
    method: 'PUT', body: ics, headers: { Authorization: 'Basic ' + Buffer.from(`alice:${token}`).toString('base64'), 'Content-Type': 'text/calendar' } })
  console.log('API PUT:', r.status)
}
const t0 = Date.now()
await dark.locator('.oc-ev', { hasText: 'Ajouté par API' }).waitFor({ timeout: 40000 })
console.log(`auto refresh: before=${before}, appeared after ${((Date.now() - t0) / 1000).toFixed(1)}s without reload`)
console.log('sync label:', await dark.locator('.sync').textContent())

// search + tabs
await dark.locator('.search input').fill('synchro')
await dark.waitForTimeout(800)
console.log('search "synchro":', await dark.locator('.oc-ev').allTextContents())
await dark.locator('.search input').fill('')
await dark.waitForTimeout(800)
await dark.getByRole('radio', { name: /Partagés avec moi/ }).click(); await dark.waitForTimeout(800)
console.log('tab shared, events:', await dark.locator('.oc-ev').count())
await dark.getByRole('radio', { name: /Tous les événements/ }).click(); await dark.waitForTimeout(800)

// editor with color picker
await dark.locator('.oc-ev', { hasText: 'Démo produit' }).first().evaluate((el) => el.click())
await dark.waitForSelector('#event-title'); await dark.waitForTimeout(500)
await dark.screenshot({ path: `${out}/d2-editor.png` })
await dark.keyboard.press('Escape')

const light = await open('light')
await light.getByRole('button', { name: 'Suivant' }).click()
await light.waitForSelector('.oc-ev'); await light.waitForTimeout(1500)
await light.screenshot({ path: `${out}/l1-week.png` })
await light.locator('.v-select.view-select').click(); await light.getByRole('option', { name: 'Vue mois' }).click(); await light.waitForTimeout(1200)
await light.screenshot({ path: `${out}/l2-month.png` })
console.log('month events:', await light.locator('.fc-daygrid-event').count(), '| weekday headers:', (await light.locator('.fc-col-header-cell').allTextContents()).join(' '))
await light.locator('.v-select.view-select').click(); await light.getByRole('option', { name: 'Vue semaine' }).click()
await light.getByRole('button', { name: "Aujourd'hui" }).click(); await light.waitForTimeout(1000)
await light.locator('.fc-timegrid-body').evaluate((el) => el.closest('.fc-scroller')?.scrollTo(0, 0))
await light.waitForTimeout(500)
await light.screenshot({ path: `${out}/l3-today.png` })
await light.locator('.v-select.view-select').click(); await light.getByRole('option', { name: 'Planning' }).click()
await light.getByRole('button', { name: 'Suivant' }).click(); await light.waitForTimeout(1200)
await light.screenshot({ path: `${out}/l4-list.png` })
console.log(errors.join('\n') || '(no errors)')
await browser.close()
