// Repeating events in a real (headless) browser, against Radicale's expansion: create a weekly event (it keeps its
// time of day across the DST change of 25 Oct 2026), delete one occurrence, move the whole series from another one,
// then stop repeating. Europe/Paris, weeks of 19 Oct – 16 Nov 2026.
// usage: [BROWSER=firefox] OC=https://localhost:9200 node test/ui-repeat.mjs <screenshot dir> [user] [password]
import { launch } from './browser.mjs'
const [out, user = 'alice', pass = 'Test-alice-12345'] = process.argv.slice(2)
const OC = process.env.OC ?? 'https://localhost:9200'
const TITLE = `Weekly sync ${Date.now() % 100000}`

let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'KO  '} ${name}${ok ? '' : ` ${detail}`}`); if (!ok) failures++ }

const browser = await launch()
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 }, timezoneId: 'Europe/Paris', locale: 'en-US' })
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
page.on('response', (r) => { if (r.status() >= 400 && /caldav|calshare/.test(r.url())) console.log(`[http ${r.status()}] ${r.request().method()} ${r.url()}`) })

async function week(date) {
  await page.goto(`${OC}/calendar?date=${date}`, { waitUntil: 'domcontentloaded' })
  if (await page.locator('input[type=password]').count().catch(() => 0)) return
  await page.waitForSelector('.fc-timegrid-col', { timeout: 30000 })
  await page.waitForTimeout(1500)
}
/** day (YYYY-MM-DD) -> time text of our event that day, or null */
async function onDay(day) {
  const ev = page.locator(`.fc-timegrid-col[data-date="${day}"] .fc-event`, { hasText: TITLE })
  if (!(await ev.count())) return null
  return ((await ev.first().locator('.oc-ev-time').textContent()) ?? '').trim()
}
async function openOn(day) {
  await page.locator(`.fc-timegrid-col[data-date="${day}"] .fc-event`, { hasText: TITLE }).first().evaluate((el) => el.click())
  await page.waitForSelector('#event-title')
  // the series loads after the editor opens
  await page.getByLabel('Repeat').waitFor({ timeout: 10000 })
}
const save = async () => { await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(2500) }

// log in
await page.goto(`${OC}/calendar`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('input[type=password], aside', { timeout: 30000 })
if (await page.locator('input[type=password]').count()) {
  await page.locator('input:not([type=password]):not([type=hidden])').first().fill(user)
  await page.locator('input[type=password]').fill(pass)
  await page.keyboard.press('Enter')
  await page.waitForURL((u) => !/signin|oidc-callback/.test(u.pathname), { timeout: 30000 })
}

// 1. create: Tuesday 20 Oct 09:00–09:30, every week
await week('2026-10-19')
await page.getByRole('button', { name: 'New event' }).click()
await page.waitForSelector('#event-title')
await page.locator('#event-title').fill(TITLE)
await page.locator('input[type=datetime-local]').nth(0).fill('2026-10-20T09:00')
await page.locator('input[type=datetime-local]').nth(1).fill('2026-10-20T09:30')
const options = await page.getByLabel('Repeat').locator('option').allTextContents()
check('presets follow the start date', options.includes('Every week on Tuesday') && options.includes('Every month on the third Tuesday'), options.join(' | '))
await page.getByLabel('Repeat').selectOption('weekly')
await page.screenshot({ path: `${out}/repeat-1-editor.png` })
await save()
check('first occurrence', (await onDay('2026-10-20'))?.startsWith('09:00'), await onDay('2026-10-20'))
await week('2026-10-26')
check('after the DST change, still 09:00', (await onDay('2026-10-27'))?.startsWith('09:00'), await onDay('2026-10-27'))
await page.screenshot({ path: `${out}/repeat-2-next-week.png` })

// 2. delete one occurrence (3 Nov)
await week('2026-11-02')
await openOn('2026-11-03')
check('the editor reads the rule back', (await page.getByLabel('Repeat').inputValue()) === 'weekly')
await page.screenshot({ path: `${out}/repeat-3-occurrence.png` })
await page.getByRole('button', { name: 'Delete…' }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${out}/repeat-4-delete-choice.png` })
await page.getByRole('button', { name: 'This occurrence' }).click()
await page.waitForTimeout(2500)
check('3 Nov deleted', (await onDay('2026-11-03')) === null)
await week('2026-11-09')
check('10 Nov still there', (await onDay('2026-11-10')) !== null)

// 3. move the series from the 10 Nov occurrence: Tuesday 09:00 -> Wednesday 10:00
await openOn('2026-11-10')
await page.locator('input[type=datetime-local]').nth(0).fill('2026-11-11T10:00')
await page.locator('input[type=datetime-local]').nth(1).fill('2026-11-11T10:30')
check('the preset follows the new day', (await page.getByLabel('Repeat').locator('option:checked').textContent()) === 'Every week on Wednesday')
await save()
check('10 Nov moved to Wednesday 11 Nov 10:00', (await onDay('2026-11-10')) === null && (await onDay('2026-11-11'))?.startsWith('10:00'), await onDay('2026-11-11'))
await week('2026-10-19')
check('the first occurrence moved too', (await onDay('2026-10-20')) === null && (await onDay('2026-10-21'))?.startsWith('10:00'))
await week('2026-11-02')
check('the deleted occurrence stays deleted', (await onDay('2026-11-04')) === null)

// 4. stop repeating
await week('2026-10-26')
await openOn('2026-10-28')
await page.getByLabel('Repeat').selectOption('none')
await save()
await week('2026-10-26')
check('no more occurrences', (await onDay('2026-10-28')) === null)
await week('2026-10-19')
check('the first one stays', (await onDay('2026-10-21'))?.startsWith('10:00'))

// clean up
await page.locator('.fc-timegrid-col[data-date="2026-10-21"] .fc-event', { hasText: TITLE }).first().evaluate((el) => el.click())
await page.getByRole('button', { name: 'Delete event' }).click()
await page.getByRole('button', { name: 'Delete', exact: true }).click()
await page.waitForTimeout(1500)
await browser.close()
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
