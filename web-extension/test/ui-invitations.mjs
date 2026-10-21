// UI test of event invitations in a real (headless) Chromium, with two users in separate sessions.
// usage: [BROWSER=firefox] OC=https://localhost:9200 node test/ui-invitations.mjs <screenshot dir>
import { launch } from './browser.mjs'
const out = process.argv[2] ?? '.'
const OC = process.env.OC ?? 'https://localhost:9200'
const browser = await launch()
const errors = []

async function session(user, pass) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 }, colorScheme: 'dark', timezoneId: 'Europe/Paris', locale: 'fr-FR' })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`[${user}] ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/photo/')) errors.push(`[${user}] HTTP ${r.status()} ${r.request().method()} ${r.url()}`) })
  await page.goto(`${OC}/calendar?date=2026-10-19`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=password]', { timeout: 30000 })
  await page.locator('input:not([type=password]):not([type=hidden])').first().fill(user)
  await page.locator('input[type=password]').fill(pass)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.fc-timegrid', { timeout: 30000 })
  await page.waitForTimeout(1500)
  return page
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` })
const event = (page, text) => page.locator('.fc-event', { hasText: text }).first()

// 1. alice creates "Point budget" on Thursday 10:00 and invites bob + admin
const alice = await session('alice', 'Test-alice-12345')
// leftovers from an interrupted run
while (await alice.locator('.fc-event', { hasText: 'Point budget' }).count()) {
  await event(alice, 'Point budget').evaluate((el) => el.click())
  await alice.getByRole('button', { name: /Supprimer l'événement/ }).click()
  await alice.locator('.oc-modal').last().getByRole('button', { name: 'Supprimer', exact: true }).click()
  await alice.waitForTimeout(2000)
}
const col = await alice.locator('.fc-timegrid-col[data-date="2026-10-22"]').boundingBox()
const slot = async (t) => (await alice.locator(`.fc-timegrid-slot-lane[data-time="${t}"]`).boundingBox()).y
await alice.mouse.move(col.x + col.width / 2, (await slot('10:00:00')) + 3)
await alice.mouse.down()
await alice.mouse.move(col.x + col.width / 2, (await slot('10:30:00')) + 15, { steps: 6 })
await alice.mouse.up()
await alice.waitForSelector('#event-title')
await alice.locator('#event-title').fill('Point budget')
for (const name of ['bob', 'admin']) {
  const search = alice.locator('input[placeholder="Rechercher par nom, identifiant ou e-mail"]')
  await search.click()
  await search.fill(name)
  await alice.locator('.vs__dropdown-option', { hasText: name === 'bob' ? 'bob' : 'Admin' }).first().click({ timeout: 10000 })
}
await alice.waitForTimeout(500)
await shot(alice, 'inv-1-alice-editor')
console.log('alice editor guests:', (await alice.locator('.oc-modal li').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim()))
await alice.getByRole('button', { name: 'Enregistrer' }).click()
await alice.waitForSelector('.fc-event:has-text("Point budget")', { timeout: 10000 })
await alice.waitForTimeout(3000)

// 2. bob sees the invitation (outlined) and accepts it
const bob = await session('bob', 'Test-bob-12345')
await event(bob, 'Point budget').waitFor({ timeout: 15000 })
console.log('bob event classes:', await event(bob, 'Point budget').getAttribute('class'))
await shot(bob, 'inv-2-bob-pending')
await event(bob, 'Point budget').evaluate((el) => el.click())
await bob.waitForSelector('.rsvp')
await shot(bob, 'inv-3-bob-rsvp')
console.log('bob dialog:', (await bob.locator('.rsvp').textContent()).replace(/\s+/g, ' ').trim())
await bob.locator('.rsvp').getByRole('button', { name: 'Accepter' }).click()
await bob.waitForTimeout(2500)
console.log('bob event classes after accept:', await event(bob, 'Point budget').getAttribute('class'))
await shot(bob, 'inv-4-bob-accepted')

// 3. alice sees bob's answer
await alice.reload(); await alice.waitForSelector('.fc-timegrid')
await event(alice, 'Point budget').waitFor({ timeout: 15000 })
await event(alice, 'Point budget').evaluate((el) => el.click())
await alice.waitForSelector('#event-title')
console.log('alice sees "Point budget" this many times:', await alice.locator('.fc-event', { hasText: 'Point budget' }).count())
console.log('alice sees:', (await alice.locator('.oc-modal li').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim()))
await shot(alice, 'inv-5-alice-answers')

// cleanup: alice deletes the event, bob's copy disappears
await alice.getByRole('button', { name: /Supprimer l'événement/ }).click()
await alice.locator('.oc-modal').last().getByRole('button', { name: 'Supprimer', exact: true }).click()
await alice.waitForTimeout(3000)
await bob.reload(); await bob.waitForSelector('.fc-timegrid'); await bob.waitForTimeout(2500)
console.log('bob still has it after delete:', await bob.locator('.fc-event', { hasText: 'Point budget' }).count())
console.log(errors.join('\n') || '(no errors)')
await browser.close()
