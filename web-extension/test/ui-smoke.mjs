// UI smoke test in a real (headless) Chromium: open, rename, create by drag, move, reload, delete, views.
// usage: [BROWSER=firefox] OC=https://localhost:9200 pnpm test:ui <screenshot dir> [user] [password]
import { launch } from './browser.mjs'
const [out, user = 'alice', pass = 'Test-alice-12345'] = process.argv.slice(2)
const browser = await launch()
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 860 }, colorScheme: 'dark', timezoneId: 'Europe/Paris', locale: 'fr-FR' })
const logs = []
page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !m.text().includes('font-src')) logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${(e.stack || e.message).slice(0, 600)}`))
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.request().method()} ${r.url()}`) })
await page.goto(`${process.env.OC ?? 'https://localhost:9200'}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('input[type=password], .fc, aside', { timeout: 30000 })
if (await page.locator('input[type=password]').count()) {
  await page.locator('input:not([type=password]):not([type=hidden])').first().fill(user)
  await page.locator('input[type=password]').fill(pass)
  await page.keyboard.press('Enter')
}
await page.waitForSelector('.fc', { timeout: 30000 }).catch(() => {})
await page.waitForTimeout(3000)
await page.screenshot({ path: `${out}/1-week.png` })
const step = async (name) => { await page.waitForTimeout(1200); await page.screenshot({ path: `${out}/${name}.png` }) }
const titles = async () => (await page.locator('.oc-ev-title, .fc-event-title').allTextContents()).join(' | ')
await page.waitForSelector('.fc-event', { timeout: 15000 }).catch(() => {})
await step('2-target-week')
console.log('target week events:', await titles())

// edit: open "Reunion Alice", rename, save with Enter
await page.locator('.fc-event', { hasText: 'Alice' }).first().evaluate((el) => el.click())
await step('3-editor')
await page.locator('#event-title').fill('Réunion Alice')
await page.getByRole('button', { name: 'Enregistrer' }).click()
await page.waitForSelector('.fc-event:has-text("Réunion Alice")', { timeout: 10000 }).catch(() => {})
console.log('after rename:', await titles())

// create: drag over Wednesday 14:00-15:30
const col = page.locator('.fc-timegrid-col[data-date="2026-10-21"]')
const slot = (t) => page.locator(`.fc-timegrid-slot-lane[data-time="${t}"]`)
await slot('15:00:00').scrollIntoViewIfNeeded()
const box = await col.boundingBox()
const y1 = (await slot('14:00:00').boundingBox()).y + 3
const y2 = (await slot('15:00:00').boundingBox()).y + 25
await page.mouse.move(box.x + box.width / 2, y1); await page.mouse.down()
await page.mouse.move(box.x + box.width / 2, y2, { steps: 8 }); await page.mouse.up()
await page.waitForSelector('#event-title', { timeout: 5000 })
await step('4-create-editor')
await page.locator('#event-title').fill('Atelier créé depuis le navigateur')
await page.getByRole('button', { name: 'Enregistrer' }).click()
await page.waitForSelector('.fc-event:has-text("Atelier")', { timeout: 10000 }).catch(() => {})
const created = page.locator('.fc-event', { hasText: 'Atelier' }).first()
console.log('created:', await created.locator('.oc-ev-time').textContent().catch(() => 'MISSING'))

// drag the new event one day later (Thursday) and one hour down
const cb = await created.boundingBox()
const dx = (await page.locator('.fc-timegrid-col[data-date="2026-10-22"]').boundingBox()).x - box.x
const dy = (await slot('15:00:00').boundingBox()).y - (await slot('14:00:00').boundingBox()).y
await page.mouse.move(cb.x + 10, cb.y + 8); await page.mouse.down()
await page.mouse.move(cb.x + 10 + dx, cb.y + 8 + dy, { steps: 12 }); await page.mouse.up()
await page.waitForTimeout(2500)
const moved = page.locator('.fc-event', { hasText: 'Atelier' }).first()
console.log('moved:', await moved.locator('.oc-ev-time').textContent(), 'day:', await moved.evaluate((el) => el.closest('.fc-timegrid-col')?.dataset.date))
await step('5-after-drag')

// reload page to prove it was persisted server-side
await page.reload(); await page.waitForSelector('.fc-timegrid', { timeout: 20000 }); await page.waitForSelector('.fc-event', { timeout: 20000 }).catch(() => {})
await page.waitForTimeout(2000)
const persisted = page.locator('.fc-event', { hasText: 'Atelier' }).first()
console.log('after reload:', await persisted.locator('.oc-ev-time').textContent().catch(() => 'MISSING'), await persisted.evaluate((el) => el.closest('.fc-timegrid-col')?.dataset.date).catch(() => ''))

// delete every "Atelier" event through the UI (also cleans leftovers from earlier runs)
let shot = false
while (await page.locator('.fc-event', { hasText: 'Atelier' }).count()) {
  await page.locator('.fc-event', { hasText: 'Atelier' }).first().evaluate((el) => el.click()); await page.waitForSelector('#event-title')
  await page.getByRole('button', { name: /Supprimer l'événement/ }).click()
  if (!shot) { await step('6-confirm-delete'); shot = true }
  await page.locator('.oc-modal').last().getByRole('button', { name: 'Supprimer', exact: true }).click()
  await page.waitForTimeout(2000)
}
console.log('after delete:', await titles())

// month + list views
await page.locator('.v-select.view-select').click(); await page.getByRole('option', { name: 'Vue mois' }).click(); await step('7-month')
await page.locator('.v-select.view-select').click(); await page.getByRole('option', { name: 'Planning' }).click(); await step('8-list')
console.log(logs.join('\n') || '(no console errors)')
await browser.close()
