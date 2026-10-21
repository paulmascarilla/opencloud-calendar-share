// Integration test of src/ical.ts against the real Radicale, through the OpenCloud proxy.
//   OC=https://localhost:9200 ALICE=alice:<app token> BOB=bob:<app token> pnpm test:integration
import assert from 'node:assert/strict'
import { EventDraft, isModifiedOccurrence, newEventIcs, parseInstances, updatedEventIcs } from "../src/ical"

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const OC = process.env.OC ?? 'https://localhost:9200'
const ALICE_ID = 'be578ae3-5d68-4ad0-9cb2-0e0c9123e76d'
const BOB_ID = '4fbd8358-64a7-419a-87a7-61485582660e'

async function call(who: string, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const auth = 'Basic ' + Buffer.from(process.env[who.toUpperCase()]!).toString('base64')
  const res = await fetch(OC + path, { method, body, headers: { Authorization: auth, ...headers } })
  return { status: res.status, etag: res.headers.get('etag') ?? '', text: await res.text() }
}

async function report(who: string, cal: string) {
  const range = 'start="20261001T000000Z" end="20261201T000000Z"'
  const { text } = await call(who, 'REPORT', cal,
    `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data><C:expand ${range}/></C:calendar-data></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range ${range}/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
    { Depth: '1', 'Content-Type': 'application/xml' })
  const out = []
  for (const m of text.matchAll(/<href>([^<]+)<\/href>.*?<C:calendar-data>([^<]*)<\/C:calendar-data>/gs)) {
    const ics = m[2].replace(/&#13;/g, '\r').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    out.push(...parseInstances(ics, decodeURIComponent(m[1]), '', cal))
  }
  return out
}

const put = (who: string, href: string, ics: string, h: Record<string, string>) =>
  call(who, 'PUT', href, ics, { 'Content-Type': 'text/calendar; charset=utf-8', ...h })

const aliceCal = `/caldav/${ALICE_ID}/def-calendar/`
const draft = (over: Partial<EventDraft>): EventDraft => ({
  calendarHref: aliceCal, title: 'Déjeuner équipe', allDay: false,
  start: new Date('2026-10-22T10:00:00Z'), end: new Date('2026-10-22T11:30:00Z'),
  location: 'Cantine', description: 'ligne 1\nligne 2, avec ; et \\', guests: [], color: null, busy: true, public: false, ...over })

// 1. create a timed event
const uid = `test-${Date.now()}`
const href = `${aliceCal}${uid}.ics`
assert.equal((await put('alice', href, newEventIcs(draft({}), uid), { 'If-None-Match': '*' })).status, 201)
let ev = (await report('alice', aliceCal)).find((e) => e.href === href)!
assert.deepEqual([ev.title, ev.start, ev.end, ev.allDay, ev.location, ev.description, ev.recurring],
  ['Déjeuner équipe', '2026-10-22T10:00:00.000Z', '2026-10-22T11:30:00.000Z', false, 'Cantine', 'ligne 1\nligne 2, avec ; et \\', false])
console.log('ok 1 create timed event')

// 2. turn it into a 2-day all-day event, with If-Match on the current etag
let got = await call('alice', 'GET', href)
const allDay = draft({ allDay: true, start: new Date(2026, 9, 23), end: new Date(2026, 9, 25), location: '' })
assert.equal((await put('alice', href, updatedEventIcs(got.text, allDay, draft({})), { 'If-Match': got.etag })).status, 204)
ev = (await report('alice', aliceCal)).find((e) => e.href === href)!
assert.deepEqual([ev.allDay, ev.start, ev.end, ev.location], [true, '2026-10-23', '2026-10-25', ''])
assert.match((await call('alice', 'GET', href)).text, /SEQUENCE:1/)
console.log('ok 2 switch to all-day, clear location, bump SEQUENCE')

// 3. stale etag is rejected (what the UI reports as a conflict)
assert.equal((await put('alice', href, updatedEventIcs(got.text, draft({}), allDay), { 'If-Match': got.etag })).status, 412)
console.log('ok 3 stale etag -> 412')

// 4. recurring series (TZID Europe/Paris): rename only, times and DST must be preserved
const rec = `${aliceCal}recur-1.ics`
got = await call('alice', 'GET', rec)
assert.equal(got.status, 200, 'recur-1.ics must exist (created during manual testing)')
const before = (await report('alice', aliceCal)).filter((e) => e.href === rec).map((e) => e.start)
assert.equal((await put('alice', rec, updatedEventIcs(got.text, draft({ title: 'Point hebdo (renommé)' }), draft({ title: 'Point hebdo' })), { 'If-Match': got.etag })).status, 204)
const after = (await report('alice', aliceCal)).filter((e) => e.href === rec)
assert.deepEqual(after.map((e) => e.start), before)
assert.deepEqual(before, ['2026-10-19T08:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-11-02T09:00:00.000Z', '2026-11-09T09:00:00.000Z'])
assert.ok(after.every((e) => e.title === 'Point hebdo (renommé)' && e.recurring))
assert.match((await call('alice', 'GET', rec)).text, /DTSTART;TZID=Europe\/Paris:20261019T100000/)
console.log('ok 4 rename recurring series, TZID + DST kept')

// 5. bob moves his own event into alice's calendar shared with him (write)
const share = await call('alice', 'PUT', '/calshare/v1/calendars/def-calendar/shares/bob', '{"permission":"write"}', { 'Content-Type': 'application/json' })
assert.ok([200, 201].includes(share.status), `share: ${share.status} ${share.text}`)
const mount = `/caldav/${BOB_ID}/def-calendar-${ALICE_ID.slice(0, 8)}/`
const bobCal = `/caldav/${BOB_ID}/def-calendar/`
const bobUid = `bob-${Date.now()}`
assert.equal((await put('bob', `${bobCal}${bobUid}.ics`, newEventIcs(draft({ calendarHref: bobCal, title: 'De Bob' }), bobUid), { 'If-None-Match': '*' })).status, 201)
got = await call('bob', 'GET', `${bobCal}${bobUid}.ics`)
assert.equal((await put('bob', `${mount}${bobUid}.ics`, updatedEventIcs(got.text, draft({ calendarHref: mount, title: 'De Bob' }), draft({ calendarHref: bobCal, title: 'De Bob' })), { 'If-None-Match': '*' })).status, 201)
assert.equal((await call('bob', 'DELETE', `${bobCal}${bobUid}.ics`, undefined, { 'If-Match': got.etag })).status, 200)
assert.ok((await report('alice', aliceCal)).some((e) => e.uid === bobUid && e.title === 'De Bob'), 'alice sees it')
assert.ok((await report('bob', mount)).some((e) => e.uid === bobUid), 'bob sees it through the mount')
assert.ok(!(await report('bob', bobCal)).some((e) => e.uid === bobUid), 'gone from bob\'s calendar')
console.log('ok 5 move event into a shared calendar')

const vcalendar = (...vevents: string[][]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...vevents.flatMap((v) => ['BEGIN:VEVENT', ...v, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n')

// 6. recurring all-day series: Radicale expands RECURRENCE-ID without VALUE=DATE
const daily = `${aliceCal}test-daily-${Date.now()}.ics`
assert.equal((await put('alice', daily, vcalendar(['UID:' + daily, 'DTSTAMP:20261001T000000Z', 'DTSTART;VALUE=DATE:20261020',
  'DTEND;VALUE=DATE:20261021', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Astreinte']), {})).status, 201)
const days = (await report('alice', aliceCal)).filter((e) => e.href === daily)
assert.deepEqual(days.map((e) => [e.start, e.end, e.allDay, e.recurrenceId]), [
  ['2026-10-20', '2026-10-21', true, '2026-10-20'], ['2026-10-21', '2026-10-22', true, '2026-10-21'],
  ['2026-10-22', '2026-10-23', true, '2026-10-22']])
console.log('ok 6 recurring all-day series')

// 7. only what the user changed is written: changes made elsewhere in the meantime survive
const merged = `${aliceCal}test-merge-${Date.now()}.ics`
assert.equal((await put('alice', merged, newEventIcs(draft({}), 'merge-' + Date.now()), { 'If-None-Match': '*' })).status, 201)
got = await call('alice', 'GET', merged)
assert.equal((await put('alice', merged, got.text.replace('LOCATION:Cantine', 'LOCATION:Salle B'), { 'If-Match': got.etag })).status, 204)
got = await call('alice', 'GET', merged)
// the editor still shows "Cantine"; the user renames the event
assert.equal((await put('alice', merged, updatedEventIcs(got.text, draft({ title: 'Renommé' }), draft({})), { 'If-Match': got.etag })).status, 204)
ev = (await report('alice', aliceCal)).find((e) => e.href === merged)!
assert.deepEqual([ev.title, ev.location], ['Renommé', 'Salle B'])
// a drag from a page still showing the old title only moves the event
got = await call('alice', 'GET', merged)
const later = draft({ start: new Date('2026-10-23T10:00:00Z'), end: new Date('2026-10-23T11:30:00Z') })
assert.equal((await put('alice', merged, updatedEventIcs(got.text, later, draft({})), { 'If-Match': got.etag })).status, 204)
ev = (await report('alice', aliceCal)).find((e) => e.href === merged)!
assert.deepEqual([ev.title, ev.location, ev.start], ['Renommé', 'Salle B', '2026-10-23T10:00:00.000Z'])
console.log('ok 7 edits and drags keep changes made elsewhere')

// 8. occurrences changed on their own (Europe/Paris, 12:00 daily from 19 Oct)
const series = `${aliceCal}test-overrides-${Date.now()}.ics`
const sid = 'UID:' + series
assert.equal((await put('alice', series, vcalendar(
  [sid, 'DTSTAMP:20261001T000000Z', 'DTSTART;TZID=Europe/Paris:20261019T120000', 'DTEND;TZID=Europe/Paris:20261019T130000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Déjeuner'],
  [sid, 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;TZID=Europe/Paris:20261020T120000', 'DTSTART;TZID=Europe/Paris:20261020T140000', 'DTEND;TZID=Europe/Paris:20261020T150000', 'SUMMARY:Déjeuner'],
  [sid, 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;TZID=Europe/Paris:20261021T120000', 'DTSTART;TZID=Europe/Paris:20261021T150000', 'DTEND;TZID=Europe/Paris:20261021T160000', 'SUMMARY:Déjeuner client']
), {})).status, 201)
let occ = (await report('alice', aliceCal)).filter((e) => e.href === series)
assert.deepEqual(occ.map((e) => e.recurrenceId), ['2026-10-19T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-21T10:00:00.000Z'])
got = await call('alice', 'GET', series)
assert.deepEqual(occ.map((e) => isModifiedOccurrence(got.text, e.recurrenceId!)), [false, true, true])
// the stored series itself (single GET, as on the invitation page) is recurring too
const stored = parseInstances(got.text, series, got.etag, aliceCal)
assert.deepEqual(stored.map((e) => [e.recurring, e.recurrenceId]), [[true, null], [true, '2026-10-20T10:00:00.000Z'], [true, '2026-10-21T10:00:00.000Z']])
// edit the 21st: only it changes
const edit = (e: typeof occ[number], title: string) => {
  const seen = draft({ title: e.title, start: new Date(e.start), end: new Date(e.end!), location: '', description: '' })
  return updatedEventIcs(got.text, { ...seen, title }, seen, e.recurrenceId)
}
assert.equal((await put('alice', series, edit(occ[2], 'Déjeuner client (Acme)'), { 'If-Match': got.etag })).status, 204)
occ = (await report('alice', aliceCal)).filter((e) => e.href === series)
assert.deepEqual(occ.map((e) => e.title), ['Déjeuner', 'Déjeuner', 'Déjeuner client (Acme)'])
// rename the series from the 19th: the 20th (moved, same title) follows, the 21st keeps its own title
got = await call('alice', 'GET', series)
assert.equal((await put('alice', series, edit(occ[0], 'Déjeuner équipe'), { 'If-Match': got.etag })).status, 204)
occ = (await report('alice', aliceCal)).filter((e) => e.href === series)
assert.deepEqual(occ.map((e) => [e.title, e.start]), [['Déjeuner équipe', '2026-10-19T10:00:00.000Z'],
  ['Déjeuner équipe', '2026-10-20T12:00:00.000Z'], ['Déjeuner client (Acme)', '2026-10-21T13:00:00.000Z']])
console.log('ok 8 edit one changed occurrence, or the series')

// 9. a guest's copy: proposals are read, and the organizer's (empty) description is shown, not the answer links
const guestCopy = vcalendar([
  'UID:copy-1', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261112T090000Z', 'DTEND:20261112T100000Z', 'SUMMARY:Revue',
  'DESCRIPTION:—\\nInvitation de alice.\\nAccepter : https://cloud.example/calendar/respond', 'X-OC-SUMMARY:Revue',
  `ORGANIZER;CN=alice;X-OC-USERID=${ALICE_ID}:mailto:alice@example.org`,
  `ATTENDEE;CN=bob;PARTSTAT=NEEDS-ACTION;X-OC-USERID=${BOB_ID};X-OC-PROPOSED-START=20261113;X-OC-PROPOSED-END=20261114:mailto:bob@example.org`
]).replace('PRODID:-//test//EN', 'PRODID:-//test//EN\r\nX-OC-ORGANIZER-HREF:/alice/def-calendar/copy-1.ics')
const [copied] = parseInstances(guestCopy, '/caldav/bob/def-calendar/copy-1.ics', '', '/caldav/bob/def-calendar/')
assert.equal(copied.description, '')
assert.deepEqual(copied.guests.map((g) => [g.name, g.proposal]), [['bob', { start: '2026-11-13', end: '2026-11-14', allDay: true }]])
console.log('ok 9 guest copy: proposal, no generated description')

// 10. busy / free (TRANSP): defaults, edits, and what others see through calshare's free/busy
const one = (lines: string[]) => parseInstances(vcalendar(['UID:b', 'DTSTAMP:20261001T000000Z', ...lines]), '/x/b.ics', '', '/x/')[0]
assert.equal(one(['DTSTART:20261112T090000Z', 'DTEND:20261112T100000Z']).busy, true, 'timed: busy by default')
assert.equal(one(['DTSTART;VALUE=DATE:20261112', 'DTEND;VALUE=DATE:20261113']).busy, false, 'all-day: free by default')
assert.equal(one(['DTSTART;VALUE=DATE:20261112', 'DTEND;VALUE=DATE:20261113', 'TRANSP:OPAQUE']).busy, true)
assert.equal(one(['DTSTART:20261112T090000Z', 'DTEND:20261112T100000Z', 'TRANSP:TRANSPARENT']).busy, false)
const freeUid = `free-${Date.now()}`
const freeHref = `${aliceCal}${freeUid}.ics`
const slot = { start: new Date('2026-11-18T09:00:00Z'), end: new Date('2026-11-18T10:00:00Z') }
assert.equal((await put('alice', freeHref, newEventIcs(draft({ ...slot, busy: false }), freeUid), { 'If-None-Match': '*' })).status, 201)
const busyAt = async () => {
  const { text } = await call('bob', 'GET', `/calshare/v1/freebusy?users=${ALICE_ID}&start=2026-11-18T00:00:00Z&end=2026-11-19T00:00:00Z`)
  return JSON.parse(text).users[0].busy.some((b: { start: string }) => b.start === '2026-11-18T09:00:00Z')
}
assert.match((await call('alice', 'GET', freeHref)).text, /TRANSP:TRANSPARENT/)
assert.equal(await busyAt(), false, 'a free event does not block')
got = await call('alice', 'GET', freeHref)
assert.equal((await put('alice', freeHref, updatedEventIcs(got.text, draft({ ...slot, busy: true }), draft({ ...slot, busy: false })), { 'If-Match': got.etag })).status, 204)
assert.equal(await busyAt(), true, 'shown as busy once changed')
const freeEvent = (await report('alice', aliceCal)).find((e) => e.href === freeHref)!
assert.equal(freeEvent.busy, true)
// all-day toggled on an event without TRANSP: it stays as shown (busy), written explicitly
const plain = vcalendar(['UID:p', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261112T090000Z', 'DTEND:20261112T100000Z'])
const toAllDay = updatedEventIcs(plain, draft({ allDay: true, start: new Date(2026, 10, 12), end: new Date(2026, 10, 13) }), draft({}))
assert.match(toAllDay, /TRANSP:OPAQUE/)
assert.doesNotMatch(updatedEventIcs(plain, draft({ title: 'x' }), draft({})), /TRANSP/, 'untouched: nothing written')
console.log('ok 10 busy / free')

// cleanup
for (const h of [href, `${aliceCal}${bobUid}.ics`, daily, merged, series, freeHref]) await call('alice', 'DELETE', h)
await call('alice', 'DELETE', '/calshare/v1/calendars/def-calendar/shares/bob')
console.log('all ok')
