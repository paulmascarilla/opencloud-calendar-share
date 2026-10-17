OPENCLOUD CALENDAR SHARE: THE WEEK, TOGETHER

A product film (desktop, web app in a browser window) for OpenCloud Calendar Share, the calendar app that
lives inside OpenCloud: plan your week, invite colleagues, answer invitations, share calendars. It should
leave the feeling of a calm, well-made OpenCloud app that a team actually uses together. Built in code
(every frame from `seek(t)`), with no templates, stock footage or stock motion graphics.

<inputs>
- The real app, captured live from https://localhost:9200 (kind cluster) in headless Chromium at 2× scale,
  English UI, light theme: snapshots of each state below, driven through the app's own controls.
- Fictional demo dataset (created for the capture, deleted afterwards): users **Camille Durand** (main
  viewpoint), **Noah Bernard**, **Inès Moreau**; ~12 events in one week ("Sprint planning", "Design review",
  "Lunch with Inès", "Customer demo"…), a calendar shared by Inès, one pending invitation for Camille.
- Brand: OpenCloud wordmark as text only (no OpenCloud logo artwork, it is their trademark), the app's
  "calendar-event" icon, Inter (packed locally from the design-system build).
- No music, no voiceover. Nothing invented: only features that exist in the build.
</inputs>

<direction>
Calm, precise, collaborative. Canvas `#F6F8FA` (surface-container), window `#FFFFFF`, ink `#191C1D`,
chrome `#20434F`, accent `#00677F`, highlight `#CFE6F1` (secondary-container); Inter for the wordmark
(700) and labels. Event colours exactly as in the app (soft tints).
Each scene grows out of the last with the app's own shapes: the app tile opens into the window; a dragged
time range grows into the event dialog; the saved event lands in the grid; the invitations bell grows into
its dropdown; the respond link page shrinks back into the calendar; the sidebar's "New calendar" button
grows into its dialog. The pointer appears only to drag, click or pick; it is hidden while typing.
Silent film: pacing on a nominal 100 BPM grid (0.6 s beat, 2.4 s bar), one action per beat, 1–2 s hold
after each result, a slow 2–3 % push-in on every hold.
Avoid: crossfades between scenes, glass, glow, particles, 3D flips, random pointer paths, fake UI, text
under ~20 px on stage, labels cut by the frame.
</direction>

<structure>
1. **Open (0–4.8 s)** – wordmark "OpenCloud Calendar Share" on the canvas; the calendar icon tile below it
   becomes a browser window (URL `cloud.example.com/calendar`).
2. **The week (4.8–10 s)** – week view assembles: sidebar, toolbar card (date badge, "October 2026",
   ← Today →, Week view), events rise in with a stagger. Camera glides across the colourful week.
3. **Plan (10–17 s)** – pointer drags over Wednesday 14:00–15:30; the selection grows into the "New event"
   dialog; title types "Design review"; a colour swatch is picked; Guests: "noa" → Noah Bernard added
   (Awaiting answer). Save → the event lands in the grid with the people mark; toast "Event created".
4. **Invited (17–24 s)** – Camille is in Files: the calendar bell appears in OpenCloud's top bar with a red
   badge, toast "New invitation – Inès Moreau invites you to “Customer demo”". The bell grows into its
   dropdown; Accept.  **Key result**: badge gone, the event in her week turns from dashed ○ to filled ●.
5. **From any CalDAV app (24–29 s)** – the invitation page opened from a CalDAV client's link: "Your answer
   has been recorded: Accepted", countdown "This page will close in 3 s"; it shrinks back into the calendar.
6. **Share (29–34 s)** – Manage sharing: search "Inès" → Can edit → "“Calendar” is now shared with Inès".
7. **New calendar (34–38 s)** – the sidebar button grows into the "New calendar" dialog, name "Projects",
   orange swatch, Create → appears in My calendars.
8. **Pull back & end (38–43.2 s)** – month view, camera pulls back to the whole window on the canvas;
   the window folds back into the icon tile under the wordmark, line: **"Your week, shared — inside
   OpenCloud."** Last frame = first frame (seamless loop).
</structure>

<build>
- `docs/launch-film/` (src in git, `out/` ignored); template `desktop`, web app window with `browserBar`.
- Landscape **1920 × 1080**, ~43 s (18 bars), 60 fps render, `CHROME=/snap/bin/chromium` for all scripts.
- Capture: a Playwright script in the film folder (`tools/capture.mjs`) logs in as each demo user and
  drives the real app to each state, saving 2× PNGs (+ element rects from the DOM for dialogs, rows, bell,
  toasts, so overlays can be cut and animated exactly). Snapshots are the source of truth; no hand edits.
- Scenes in `scenes.js`: state images in the window, region reveals (clip) for what changes between two
  states, dialogs grown from their source rect, pointer and camera keyed on beats `B(n)`.
- Demo data: `tools/seed.sh` creates the 3 users (English), events, share and invitations through Graph,
  CalDAV and the calshare API; `tools/cleanup.sh` removes users, events and shares afterwards.
- QA: `check.mjs` (determinism, loop), reviewer agents per ~12 s stretch + phone-size pass, scores ≥ 8.
- Deliverables: `out/opencloud-calendar-share.mp4` (silent), `-loop.mp4`, `-poster.png`,
  `dist/opencloud-calendar-share.html`, `README.md` (beat map, how to re-capture/render), `brief.md`.
</build>

<start>
After approval: seed the demo data and capture the snapshots, then show the beat map and four stills
(opening tile, the "New event" dialog with Noah added, the bell dropdown Accept moment, the closing frame)
and wait for feedback before building the whole film.
</start>

## Status

- Step reached: 6 (render) for the icon update; `docs/assets/demo.mp4` / `demo.gif` are this film's 1× render.
- Done: the tile uses the repo icon (`docs/assets/icon.svg`): glyph `assets/img/icon-app.svg` (the colour icon
  without its tile; the extension's menu uses a one-colour version) packed as `ASSETS.img.icon`, on the `--chrome` tile, radius 35, glyph at
  176/224 of the tile. `check.mjs` passes. Render in 12 s chunks (`--from/--to`) then `ffmpeg -f concat`: the
  machine is short on RAM with the kind cluster up and a full-length render times out in Chrome.
- Next: reviewer QA, final 2× render, loop, poster, single HTML, README, `tools/cleanup.sh`.
- Open: "Customer demo" shows twice in the week (Camille's copy + Inès's shared original); demo data still in
  the cluster; `CHROME=/snap/bin/chromium`.
