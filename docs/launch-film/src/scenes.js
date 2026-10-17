film({ W: 1920, H: 1080, BPM: 100, BEATS: 77 });

// OpenCloud Calendar Share — product film. The app is the real OpenCloud Web + calendar extension,
// captured by tools/capture.mjs (snapshots in assets.js, element rects in rects.js). The film only moves
// the window, the camera and the pointer, and reveals what changes between two captured states.

const APP = { name: "OpenCloud Calendar Share", line: "Your week, shared inside OpenCloud." };
const CW = 1200, CH = 730, BAR = 50, TALL_H = 2520;        // app content in window points, browser bar
const GRID = { x: 290, y: 332, w: 876, h: 373 };           // the week's time-grid viewport
const TALL_BODY = 332.5;                                   // grid body top in the "-tall" captures
const S08 = 616, S12 = 924;                                // grid scroll offsets of 08:00 and 12:00
const BACKDROP = 0.4;                                      // OpenCloud's dialog backdrop (black, 40 %)
const IMGS = ["week", "week_tall", "week_afternoon", "select", "editor_empty", "editor_title", "editor_color",
  "editor_search", "editor_guest", "saved", "files_invited", "files_bell", "bell_open", "bell_accepted",
  "week_pending", "week_pending_tall", "week_invite", "week_invite_tall", "respond", "sharing", "sharing_search",
  "sharing_ready", "sharing_done", "sidebar", "newcal", "newcal_done", "month"];
// the repo icon (docs/assets/icon.svg): its glyph spans 176 of the tile's 224 units, corner radius 52/224
const TILE = { size: 150, r: 35, icon: 176 / 224 };
const Z_WIN = 1.24;                                        // whole window on the 1920 × 1080 stage

const P = (x, y) => ({ x: WIN.x + x, y: WIN.y + BAR + y }); // content point → screen point
// camera on a content point; close-ups stay inside the window (no band of canvas under or over it)
const C = (x, y, z) => {
  const v = onWindow(x, y + BAR, z), half = FILM.H / 2 / z;
  const halfW = FILM.W / 2 / z;
  return z < 1.4 ? v : { ...v, cx: clamp(v.cx, WIN.x + halfW, WIN.x + WIN.w - halfW), cy: clamp(v.cy, WIN.y + half, WIN.y + WIN.h - half) };
};
const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p, r: (r.r || 0) + p });

const K = {};
const POINTER = [];
const CLICKS = [];

function timeline() {
  Object.assign(K, {
    // 1. open: the tile becomes the browser window, the week assembles
    lineOut: B(2), wmOut: B(3), open: B(3.5), chrome: B(4.2), side: B(4.5), head: B(4.9), grid: B(5.3),
    // 2. the week
    look: B(8), look2: B(11), scroll: B(13),
    // 3. plan an event
    ptr: B(15), down: B(16), up: B(17.5), titleCam: B(18.4), type: B(19), color: B(21), guestCam: B(22),
    gclick: B(23), gtype: B(23.5), gdrop: B(24.2), pick: B(25), save: B(27), toast1: B(28),
    // 4. invited, in Files
    files: B(31), toastIn: B(32.5), bellCam: B(34), bell: B(35), accept: B(37), after: B(38.2),
    cal: B(40), refresh: B(42),
    // 5. answered from a calendar app's link
    resp: B(45), close: B(51),
    // 6. share a calendar
    share: B(53), pclick: B(54), ptype: B(54.5), pdrop: B(55.2), pick2: B(56), shareBtn: B(58), toast2: B(58.6),
    // 7. a new calendar
    nc: B(61), ncClick: B(62), ncType: B(63), create: B(65),
    // 8. month, pull back, fold into the tile
    month: B(68), back: B(70), fold: B(72), wmIn: B(73), lineIn: B(74.5),
  });
  const wed = R["week-afternoon"].wed, s14 = R["week-afternoon"].s14;
  const drag0 = P(wed.x + wed.w / 2, s14.y + 6), drag1 = P(wed.x + wed.w / 2, R.select.mirror.y + R.select.mirror.h - 12);
  const sw = R["editor-color"].swatch, gIn = R["editor-color"].guests, opt = R["editor-search"].option;
  const save = R["editor-guest"].save, bell = R["files-bell"].bell, acc = R["bell-open"].accept;
  const shareBtn = R["sharing-ready"].share, ncBtn = R.sidebar.button, create = R.newcal.create;
  const at = (r) => P(r.x + r.w / 2, r.y + r.h / 2);
  POINTER.splice(0, POINTER.length,
    { t: 0, ...P(900, 640) },
    { t: K.ptr, ...drag0, d: 0.55 }, { t: K.down + 0.05, ...drag1, d: 0.55 },
    { t: K.color - 0.55, ...at(sw), d: 0.5 },
    { t: K.gclick - 0.5, ...P(gIn.x + 120, gIn.y + gIn.h / 2), d: 0.45 },
    { t: K.pick - 0.5, ...P(opt.x + 80, opt.y + opt.h / 2), d: 0.45 },
    { t: K.save - 0.55, ...at(save), d: 0.5 },
    { t: K.bell - 0.5, ...at(bell), d: 0.45 },
    { t: K.accept - 0.55, ...P(acc.x + acc.w - 16, acc.y + acc.h * 0.62), d: 0.5 },
    { t: K.pclick - 0.5, ...P(420, 415), d: 0.45 },
    { t: K.pick2 - 0.5, ...P(330, 454), d: 0.45 },
    { t: K.shareBtn - 0.55, ...P(shareBtn.x + shareBtn.w / 2, shareBtn.y + shareBtn.h / 2), d: 0.5 },
    { t: K.ncClick - 0.55, ...at(ncBtn), d: 0.5 },
    { t: K.create - 0.55, ...at(create), d: 0.5 });
  CLICKS.splice(0, CLICKS.length, K.down, K.color, K.gclick, K.pick, K.save, K.bell, K.accept, K.pclick, K.pick2, K.shareBtn, K.ncClick, K.create);
}

function build(stage) {
  timeline();
  const imgs = IMGS.flatMap((k) => Array.from({ length: COPIES }, (_, i) =>
    `<img class="abs" data-k="im_${k}_${i}" alt="" src="${ASSETS.img[k]}" style="left:0;top:0;width:${CW}px;height:${k.endsWith("_tall") ? TALL_H : CH}px;transform-origin:0 0">`)).join("");
  const app = `
    <div class="abs" data-k="content" style="z-index:0;left:0;top:${BAR}px;width:${CW}px;height:${CH}px;overflow:hidden;background:#fff">
      ${imgs}
      <div class="abs" data-k="dim" style="left:0;top:0;width:${CW}px;height:${CH}px;background:#000"></div>
      <div class="abs" data-k="cover" style="background:#fff"></div>
      <div class="abs" data-k="blank" style="background:#fff"></div>
      <i class="abs" data-k="caret" style="width:1.5px;height:17px;background:var(--ink)"></i>
    </div>
    <div class="abs row" data-k="bar" style="z-index:1;left:0;top:0;width:${CW}px;height:${BAR}px;padding:0 16px 0 96px;background:var(--side);box-shadow:inset 0 -1px 0 var(--hair)">
      <div class="row" style="margin:0 auto;width:560px;height:32px;padding:0 14px;gap:8px;border-radius:9px;background:var(--winBg);font-size:14px;color:var(--ink2);box-shadow:inset 0 0 0 1px var(--hair)">
        <svg width="12" height="14" viewBox="0 0 12 14"><rect x="1" y="6" width="10" height="7.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.4 6V4.2a2.6 2.6 0 0 1 5.2 0V6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
        <span class="t" data-k="url" style="line-height:32px"></span>
      </div>
    </div>
    <div class="abs" data-k="tint" style="z-index:2;left:0;top:0;width:${CW}px;height:${WIN.h}px;background:var(--chrome)"></div>
    <img class="abs" data-k="wicon" alt="" src="${ASSETS.img.icon}" style="z-index:3;left:0;top:0;width:100px;height:100px;transform-origin:0 0">`;
  stage.innerHTML = `
    <div class="full" style="background:var(--bg)"></div>
    ${desktopMarkup(app, { name: "OpenCloud", dock: 0 })}
    <div class="abs center" data-k="capClip" style="left:0;top:888px;width:${FILM.W}px;height:170px;overflow:hidden">
      <div data-k="cap" style="display:flex;flex-direction:column;align-items:center;padding:20px 44px;border-radius:20px;background:var(--chrome);color:#fff;text-align:center;box-shadow:0 12px 32px rgba(15,30,36,.22)">
        <div class="t" style="font-size:32px;font-weight:600;line-height:42px">With GNOME Calendar, Thunderbird or another CalDAV app</div>
        <div class="t" style="font-size:26px;font-weight:400;line-height:36px;opacity:.88">the Accept, Maybe and Decline links in the invitation open this page</div>
      </div>
    </div>
    <div class="full" data-k="word">
      <div class="abs center" data-k="tile" style="border-radius:${TILE.r}px;background:var(--chrome)"><img alt="" data-k="tileIcon" src="${ASSETS.img.icon}"></div>
      <div class="abs mask" data-k="wmClip" style="height:130px"><div data-k="wm" class="t" style="font-size:96px;font-weight:700;letter-spacing:-.03em;line-height:130px;color:var(--ink)">${APP.name}</div></div>
      <div class="abs mask" data-k="lnClip" style="height:60px"><div data-k="ln" class="t" style="font-size:38px;font-weight:500;line-height:60px;color:var(--ink2)">${APP.line}</div></div>
    </div>`;
  stage.querySelector('[data-k="pointer"]').insertAdjacentHTML("beforebegin", `<div class="abs" data-k="ring" style="left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid var(--accent);background:color-mix(in srgb, var(--accent) 14%, transparent)"></div>`);
  collect(stage);
  const wmW = measure(APP.name, 96, 700, "letter-spacing:-.03em;font-family:Inter");
  const lnW = measure(APP.line, 38, 500, "font-family:Inter");
  Object.assign($.wmClip.style, { left: Math.round((FILM.W - wmW) / 2) + "px", top: "520px", width: Math.ceil(wmW + 6) + "px" });
  Object.assign($.lnClip.style, { left: Math.round((FILM.W - lnW) / 2) + "px", top: "668px", width: Math.ceil(lnW + 4) + "px" });
  TILE.rect = { x: (FILM.W - TILE.size) / 2, y: 330, w: TILE.size, h: TILE.size, r: TILE.r };
  // typed text widths, scaled to the measured width of the captured text
  TYPE.forEach((f) => {
    const full = measure(f.text, 14, 400, "font-family:Inter");
    f.widths = [...f.text].map((_, i) => (measure(f.text.slice(0, i + 1), 14, 400, "font-family:Inter") / full) * (f.x1 - f.x0));
  });
}

// Typed fields: where the captured text starts and ends (measured from the snapshots).
const TYPE = [
  { key: "title", text: "Design review", x0: 373.3, x1: 464.3, y: 133, h: 29, step: 0.07 },
  { key: "guests", text: "noa", x0: 377, x1: 399.3, y: 592, h: 21, step: 0.1 },
  { key: "picker", text: "Inè", x0: 237.3, x1: 255, y: 403, h: 25, step: 0.1 },
  { key: "name", text: "Projects", x0: 373.3, x1: 424.7, y: 310, h: 29, step: 0.08 },
];
const field = (k) => TYPE.find((f) => f.key === k);

// ---- layers ---------------------------------------------------------------------------------------
// a state can be drawn several times in one frame (top bar, body, toast…): each draw takes its own copy
const COPIES = 4;
let Z = 0;
const used = {};
function resetLayers() {
  Z = 0;
  for (const k of IMGS) {
    used[k] = 0;
    for (let i = 0; i < COPIES; i++) show($[`im_${k}_${i}`], false);
  }
  show($.dim, false); show($.cover, false); show($.caret, false); show($.blank, false);
}

/** Shows a captured state; clip in image points, then translate / scale. */
function lay(key, { clip, x = 0, y = 0, s = 1, origin, a = 1 } = {}) {
  if (used[key] >= COPIES) throw new Error(`more than ${COPIES} layers of ${key}`);
  const el = $[`im_${key}_${used[key]++}`];
  show(el, true);
  el.style.zIndex = String(++Z);
  const h = key.endsWith("_tall") ? TALL_H : CH;
  el.style.clipPath = clip
    ? `inset(${clip.y.toFixed(2)}px ${(CW - clip.x - clip.w).toFixed(2)}px ${(h - clip.y - clip.h).toFixed(2)}px ${clip.x.toFixed(2)}px round ${(clip.r || 0).toFixed(2)}px)`
    : "none";
  el.style.transformOrigin = origin ? `${origin.x}px ${origin.y}px` : "0 0";
  setT(el, `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) scale(${s.toFixed(4)})`);
  el.style.opacity = a.toFixed(3);
}

/** The whole-day grid of a "-tall" capture, scrolled to body offset S, inside the week's grid viewport. */
function grid(key, S, dy = 0) {
  const y = GRID.y - TALL_BODY - S + dy;
  lay(key, { y, clip: { x: GRID.x, y: GRID.y - y + Math.max(0, dy), w: GRID.w, h: GRID.h - Math.max(0, dy) } });
}

function dim(p) {
  if (p <= 0) return;
  show($.dim, true);
  $.dim.style.zIndex = String(++Z);
  $.dim.style.opacity = (BACKDROP * clamp(p)).toFixed(3);
}

/** Typing into a captured field: the not-yet-typed part is covered by the field's white, with a caret. */
function typing(t, f, t0) {
  const n = clamp(Math.floor((t - t0) / f.step) + 1, 0, f.text.length);
  const x = f.x0 + (n ? f.widths[n - 1] : 0);
  show($.cover, true);
  $.cover.style.zIndex = String(++Z);
  rectCss($.cover, { x: x + 0.6, y: f.y, w: f.x1 - x + 4, h: f.h, r: 0 });
  show($.caret, n < f.text.length || t < t0 + f.text.length * f.step + 0.5);
  $.caret.style.zIndex = String(++Z);
  setT($.caret, `translate(${(x + 1).toFixed(2)}px,${(f.y + f.h / 2 - 8.5).toFixed(2)}px)`);
}

/** New page content rises in under the OpenCloud top bar (y > 56), the old one sinks. */
function swap(t, t0, from, to) {
  const p = prog(t, t0, 0.5, E.snappy);
  if (p < 1 && from) lay(from, { clip: { x: 0, y: 56, w: CW, h: CH - 56 }, y: 0, a: 1 - p });
  lay(to, { clip: { x: 0, y: 56 - (1 - p) * 40, w: CW, h: CH - 56 }, y: (1 - p) * 40 });
  lay(to, { clip: { x: 0, y: 0, w: CW, h: 56 } });
  return p;
}

const toastIn = (t, t0, key, r) => {
  const p = clamp(spring(t, t0, 0.45, 0.86), 0, 1);
  if (p > 0) lay(key, { clip: r, x: (1 - p) * (CW - r.x) });
};

// ---- the film ------------------------------------------------------------------------------------
function apply(t) {
  resetLayers();
  show($.capClip, false);
  const v = camera(t);
  const worldOn = t >= K.open && t < K.fold + 0.75;
  show($.world, worldOn);
  if (worldOn) {
    const opening = prog(t, K.open, 0.75, E.inOut), folding = prog(t, K.fold, 0.7, E.inOut);
    const rect = t < K.fold ? mixRect(tileInWindow(v), FULL, opening) : mixRect(FULL, tileInWindow(v), folding);
    const chrome = prog(t, K.chrome, 0.35, E.out) * (1 - prog(t, K.fold, 0.25, E.in));
    placeWorld(v, { rect, chrome, desk: 0, hw: 0, lid: 1 });
    // the tile's colour and icon fade into the white window as it opens, and back as it folds
    const tint = t < K.fold ? 1 - prog(t, K.open + 0.25, 0.4, E.out) : prog(t, K.fold + 0.1, 0.35, E.out);
    // the tile's icon stays centred in the window shape, at the tile's proportion
    const ic = Math.min(rect.w, rect.h) * TILE.icon;
    setT($.wicon, `translate(${(rect.x + (rect.w - ic) / 2).toFixed(2)}px,${(rect.y + (rect.h - ic) / 2).toFixed(2)}px) scale(${(ic / 100).toFixed(4)})`);
    show($.tint, tint > 0.001); show($.wicon, tint > 0.001);
    $.tint.style.opacity = tint.toFixed(3);
    $.wicon.style.opacity = tint.toFixed(3);
    $.bar.style.opacity = chrome.toFixed(3);
    show($.content, t >= K.open && t < K.fold + 0.5);
    $.url.textContent = url(t);
    applyApp(t);
    placePointer(t, POINTER, CLICKS, K.ptr - 0.15, K.month);
    // each click leaves a ring under the pointer
    const c = CLICKS.find((c0) => t >= c0 && t < c0 + 0.5);
    show($.ring, c !== undefined);
    if (c !== undefined) {
      const q = (t - c) / 0.5, at = pointerAt(c, POINTER);
      setT($.ring, `translate(${at.x.toFixed(2)}px,${at.y.toFixed(2)}px) scale(${(0.5 + 0.9 * E.out(q)).toFixed(4)})`);
      $.ring.style.opacity = (1 - q).toFixed(3);
    }
    $.pointer.style.opacity = (pointerOn(t)).toFixed(3);
  }
  applyWord(t);
}

const url = (t) =>
  t >= K.resp && t < K.close + 0.3 ? "cloud.example.com/calendar/respond?event=sprint-retro" :
  t >= K.files && t < K.cal ? "cloud.example.com/files/spaces/personal" :
  t >= K.share && t < K.nc ? "cloud.example.com/calendar/sharing" : "cloud.example.com/calendar";

// the pointer is hidden while typing and between scenes
function pointerOn(t) {
  const typingSpans = [[K.type - 0.1, K.type + 1.05], [K.gtype - 0.05, K.gtype + 0.4], [K.ptype - 0.05, K.ptype + 0.4], [K.ncType - 0.1, K.ncType + 0.75]];
  const typingNow = typingSpans.some(([a, b]) => t >= a && t < b);
  const gaps = [[K.toast1 + 0.4, K.bell - 0.6], [K.after + 0.2, K.pclick - 0.6], [K.toast2 + 0.3, K.ncClick - 0.6]];
  const away = gaps.some(([a, b]) => t >= a && t < b);
  return typingNow || away ? 0 : prog(t, K.ptr - 0.15, 0.2, E.out);
}

function camera(t) {
  const W0 = C(600, 365, Z_WIN);
  const demo = R["week-pending"].demo, modal = R["editor-empty"].modal;
  return cameraAt(t, [
    { t: 0, ...W0 },
    { t: K.look, ...C(520, 450, 1.62), d: 1.0 },
    { t: K.look2, ...C(860, 450, 1.62), d: 1.1 },
    { t: K.scroll, ...C(700, 470, 1.5), d: 1.0 },
    { t: K.ptr - 0.3, ...C(640, 520, 1.72), d: 0.9 },
    { t: K.up + 0.1, ...C(600, modal.y + modal.h / 2, 1.5), d: 0.8 },
    { t: K.titleCam, ...C(600, 230, 1.95), d: 0.7 },
    { t: K.guestCam, ...C(600, 560, 1.9), d: 0.8 },
    { t: K.save + 0.2, ...C(640, 540, 1.65), d: 0.8 },
    { t: K.files, ...W0, d: 0.8 },
    { t: K.bellCam, ...C(700, 200, 1.85), d: 0.8 },
    { t: K.after, ...C(700, 420, 1.45), d: 0.8 },
    { t: K.cal + 0.2, ...C(demo.x + demo.w / 2 - 40, demo.y + 40, 2.0), d: 0.9 },
    { t: K.resp - 0.1, ...C(600, 330, 1.6), d: 0.8 },
    { t: K.close, ...W0, d: 0.8 },
    { t: K.share + 0.1, ...C(600, 400, 1.6), d: 0.8 },
    { t: K.nc, ...C(470, 340, 1.55), d: 0.8 },
    { t: K.month, ...W0, d: 0.8 },
    { t: K.back, ...C(600, 365, 0.98), d: 1.0 },
  ]);
}

function tileInWindow(v) {
  const r = TILE.rect;
  return { x: (r.x - FILM.W / 2) / v.z + v.cx - WIN.x, y: (r.y - FILM.H / 2) / v.z + v.cy - WIN.y, w: r.w / v.z, h: r.h / v.z, r: r.r / v.z };
}

function applyApp(t) {
  if (t < K.files) planScenes(t);
  else if (t < K.resp) inviteScenes(t);
  else if (t < K.share) respondScene(t);
  else if (t < K.nc) shareScene(t);
  else newCalendarScene(t);
}

// 1–3: the week, then a new event with a guest
function planScenes(t) {
  const wk = R.week;
  if (t < K.scroll) {
    // the page assembles: sidebar, header, then the grid wipes down
    const side = clamp(spring(t, K.side, 0.55, 0.88), 0, 1);
    lay("week", { clip: { x: 0, y: 0, w: CW, h: 56 } });
    lay("week", { clip: { x: 0, y: 56, w: 280, h: CH - 56 }, x: (1 - side) * -280 });
    const head = clamp(spring(t, K.head, 0.5, 0.88), 0, 1);
    if (head > 0) lay("week", { clip: { x: 280, y: 56, w: CW - 280, h: GRID.y - 56 }, y: (1 - head) * 24, a: Math.min(1, head * 1.4) });
    const g = prog(t, K.grid, 0.6, E.out);
    if (g > 0) lay("week", { clip: { x: 280, y: GRID.y, w: CW - 280, h: (CH - GRID.y) * g } });
    return;
  }
  if (t < K.down) {
    lay("week");
    grid("week_tall", lerp(S08, S12, prog(t, K.scroll, 1.0, E.smooth)));
    return;
  }
  // drag: the selection follows the pointer from 14:00 to 15:30
  const mir = R.select.mirror;
  if (t < K.up) {
    lay("week_afternoon");
    const g = clamp((t - K.down) / 0.6, 0, 1), h = lerp(38.5, mir.h, E.smooth(g));
    lay("select", { clip: { x: mir.x, y: mir.y, w: mir.w, h, r: 4 } });
    return;
  }
  const modal = R["editor-empty"].modal;
  const created = R.saved.created;
  if (t < K.save + 0.12) {
    // the selection grows into the New event dialog
    const open = clamp(spring(t, K.up + 0.05, 0.5, 0.9), 0, 1);
    lay("select");
    dim(prog(t, K.up, 0.35, E.out));
    if (t < K.gdrop) {
      let state = "editor_empty";
      if (t >= K.type) state = "editor_title";
      if (t >= K.color + 0.08) state = "editor_color";
      lay(state, { clip: { ...mixRect({ ...mir, r: 4 }, { ...modal, r: 8 }, open) } });
      if (t >= K.type && t < K.type + 1.6) typing(t, field("title"), K.type);
      if (t >= K.gtype) {
        // "noa" comes from the search capture's field, shown at the dialog's unscrolled position
        const g = R["editor-color"].guests, sc = R["editor-search"].body.scroll;
        lay("editor_search", { clip: { x: g.x - 4, y: g.y - sc - 4, w: g.w, h: g.h + 8 }, y: sc });
        typing(t, field("guests"), K.gtype);
      }
    } else if (t < K.pick + 0.1) {
      // the result list opens under the field and the dialog scrolls it into view
      const sc = R["editor-search"].body.scroll;
      dialog("editor_search", sc * prog(t, K.gdrop, 0.4, E.inOut));
    } else {
      // Noah is added: the list closes, his row appears, the dialog scrolls to it
      const s0 = R["editor-search"].body.scroll, s1 = R["editor-guest"].body.scroll;
      dialog("editor_guest", lerp(s0, s1, prog(t, K.pick + 0.1, 0.35, E.inOut)));
    }
    return;
  }
  // Save: the dialog shrinks into the new event, the toast slides in
  const shrink = prog(t, K.save + 0.12, 0.5, E.inOut);
  lay("saved");
  coverToast(t, "saved", R["files-invited"].toast, K.toast1);
  if (shrink < 1) {
    dim(1 - shrink);
    lay("editor_guest", { clip: mixRect({ ...modal, r: 8 }, { ...created, r: 4 }, shrink), a: 1 - prog(t, K.save + 0.45, 0.17) });
  }
}

/** A dialog state whose body is scrolled to `cur` (the capture's own scroll is in rects). */
function dialog(key, cur) {
  const k = key.replace("_", "-"), m = R[k].modal, b = R[k].body, dy = b.scroll - cur;
  lay(key, { clip: { x: m.x, y: m.y, w: m.w, h: b.y - m.y, r: 8 } });
  lay(key, { clip: { x: m.x, y: b.y + b.h, w: m.w, h: m.y + m.h - b.y - b.h, r: 8 } });
  lay(key, { clip: { x: b.x, y: b.y - dy, w: b.w, h: b.h }, y: dy });
}

// the toast of a captured state: its place shows the state before, then the toast slides in from the right
function coverToast(t, key, toast, t0) {
  const r = { ...pad(toast, 2), r: 8 };
  const base = key === "saved" ? "week_afternoon" : key === "sharing_done" ? "sharing_ready" : "files_bell";
  const p = clamp(spring(t, t0, 0.45, 0.86), 0, 1);
  lay(base, { clip: r });
  if (p > 0) lay(key, { clip: r, x: (1 - p) * (CW - r.x + 8) });
}

// 4: invited while in Files; accept from the bell; the week updates
function inviteScenes(t) {
  if (t < K.cal) {
    swap(t, K.files, "saved", "files_bell");
    const bellR = R["files-bell"].bell, drop = R["bell-open"].drop;
    // toast "New invitation" slides in; the badge beats once
    if (t < K.bell) {
      const r = { ...pad(R["files-invited"].toast, 2), r: 8 };
      const p = clamp(spring(t, K.toastIn, 0.45, 0.86), 0, 1);
      if (p > 0 && t < K.bell - 0.2) lay("files_invited", { clip: r, x: (1 - p) * (CW - r.x + 8), a: 1 - prog(t, K.bell - 0.5, 0.3, E.in) });
      const beat = 1 + 0.35 * pulse(t, K.toastIn + 0.1, 0.45);
      lay("files_bell", { clip: pad(bellR, 12), origin: mid(bellR), s: beat });
    }
    if (t >= K.bell && t < K.accept + 0.5) {
      // the bell grows into its dropdown; Accept folds it back into the bell
      const open = clamp(spring(t, K.bell + 0.05, 0.42, 0.88), 0, 1), close = prog(t, K.accept + 0.12, 0.35, E.inOut);
      const r = mixRect({ ...bellR, r: 6 }, { ...drop, r: 8 }, open * (1 - close));
      lay("bell_open", { clip: r });
      // Accept is pressed
      const acc = R["bell-open"].accept;
      if (t >= K.accept - 0.1 && close === 0) lay("bell_open", { clip: { ...acc, r: 4 }, origin: mid(acc), s: press(t, K.accept, 0.92) });
    }
    if (t >= K.accept + 0.47) {
      lay("bell_accepted", { clip: { x: 900, y: 0, w: 120, h: 56 } });
      toastIn(t, K.accept + 0.55, "bell_accepted", { ...pad(R["bell-accepted"].toast, 2), r: 8 });
    }
    return;
  }
  // the week: Customer demo was pending (dashed) and turns accepted when the view refreshes
  swap(t, K.cal, "bell_accepted", "week_pending");
  if (t >= K.refresh) {
    const d = R["week-invite"].demo, p = clamp(spring(t, K.refresh, 0.42, 0.7), 0, 1.06);
    lay("week_invite", { clip: pad(d, 3), origin: mid(d), s: 0.94 + 0.06 * p });
  }
}

// 5: the invitation page, opened from the Accept link of a calendar app
function respondScene(t) {
  // caption: who this page is for
  const capIn = clamp(spring(t, K.resp + 0.5, 0.5, 0.9), 0, 1), capOut = prog(t, K.close - 0.35, 0.3, E.in);
  show($.capClip, capIn > 0 && capOut < 1);
  setT($.cap, `translateY(${((1 - capIn + capOut) * 170).toFixed(2)}px)`);
  const push = prog(t, K.resp, 0.55, E.snappy), close = prog(t, K.close, 0.55, E.inOut);
  lay("week_invite");
  if (close < 1) {
    const s = 1 - 0.18 * close;
    lay("respond", { x: (1 - push) * CW, origin: { x: 600, y: 300 }, s, a: 1 - prog(t, K.close + 0.25, 0.3) });
    // the capture caught a "New invitation" toast from the bell; the page under it is empty
    show($.blank, true);
    $.blank.style.zIndex = String(++Z);
    rectCss($.blank, { x: 776, y: 596, w: 415, h: 125, r: 0 });
    setT($.blank, `translate(${((1 - push) * CW).toFixed(2)}px,0)`);
    $.blank.style.transformOrigin = `${600 - 776}px ${300 - 596}px`;
    setT($.blank, `translate(${((1 - push) * CW).toFixed(2)}px,0) scale(${s.toFixed(4)})`);
    $.blank.style.opacity = (1 - prog(t, K.close + 0.25, 0.3)).toFixed(3);
  }
}

// 6: share the "Calendar" calendar with Inès, Can edit
function shareScene(t) {
  swap(t, K.share, "week_invite", "sharing");
  const opt = R["sharing-search"].option;
  if (t >= K.ptype && t < K.pick2 + 0.05) {
    lay("sharing_search", { clip: { x: 220, y: 395, w: 480, h: 40 } });
    if (t < K.pdrop + 0.6) typing(t, field("picker"), K.ptype);
    const d = clamp(spring(t, K.pdrop, 0.4, 0.86), 0, 1);
    if (d > 0) lay("sharing_search", { clip: { x: opt.x - 6, y: opt.y - 4, w: opt.w + 12, h: (opt.h + 10) * d } });
  }
  if (t >= K.pick2 + 0.05) {
    // the page scrolls with the focused field; Inès and Can edit are set
    const s = prog(t, K.pick2 + 0.05, 0.4, E.snappy), dy = 76 * (1 - s);
    lay("sharing_ready", { clip: { x: 0, y: 97, w: CW, h: CH - 97 }, y: dy });
    if (t >= K.shareBtn + 0.1) {
      // the share lands as a row in the card
      const done = R["sharing-done"].card, g = prog(t, K.shareBtn + 0.1, 0.4, E.snappy), h = lerp(107, done.h, g);
      lay("sharing_done", { clip: { x: 0, y: 97, w: CW, h: done.y + h - 97 } });
      lay("sharing_done", { clip: { x: 0, y: done.y + done.h, w: CW, h: CH - done.y - done.h }, y: h - done.h });
      coverToast(t, "sharing_done", R["sharing-done"].toast, K.toast2);
    }
  }
}

// 7–8: a new calendar, then the month, the pull-back and the fold into the tile
function newCalendarScene(t) {
  if (t < K.month) {
    swap(t, K.nc, "sharing_done", "sidebar");
    const btn = R.sidebar.button, modal = R.newcal.modal, item = R["newcal-done"].item;
    if (t >= K.ncClick + 0.08 && t < K.create + 0.12) {
      const open = clamp(spring(t, K.ncClick + 0.08, 0.5, 0.9), 0, 1);
      dim(prog(t, K.ncClick + 0.05, 0.35, E.out));
      lay("newcal", { clip: mixRect({ ...btn, r: 6 }, { ...modal, r: 8 }, open) });
      if (t >= K.ncType - 0.2) typing(t, field("name"), K.ncType);
    }
    if (t >= K.create + 0.12) {
      const shrink = prog(t, K.create + 0.12, 0.5, E.inOut);
      lay("newcal_done");
      if (shrink < 1) {
        dim(1 - shrink);
        lay("newcal", { clip: mixRect({ ...modal, r: 8 }, { ...item, r: 6 }, shrink), a: 1 - prog(t, K.create + 0.4, 0.2) });
      }
      const flash = pulse(t, K.create + 0.6, 0.6);
      if (flash > 0) lay("newcal_done", { clip: pad(item, 2), origin: mid(item), s: 1 + 0.05 * flash });
    }
    return;
  }
  swap(t, K.month, "newcal_done", "month");
}

// the wordmark, the line and the tile, outside the window: first frame = last frame
function applyWord(t) {
  const wmOut = prog(t, K.wmOut, 0.32, E.in), wmIn = prog(t, K.wmIn, 0.45, E.out);
  const lnOut = prog(t, K.lineOut, 0.3, E.in), lnIn = prog(t, K.lineIn, 0.45, E.out);
  show($.wmClip, t < K.wmOut + 0.32 || t >= K.wmIn);
  show($.lnClip, t < K.lineOut + 0.3 || t >= K.lineIn);
  if (t < K.wmIn) sink($.wm, wmOut); else rise($.wm, wmIn);
  if (t < K.lineIn) sink($.ln, lnOut); else rise($.ln, lnIn);
  // no descender left at the mask's edge
  $.wm.style.opacity = (t < K.wmIn ? 1 - prog(t, K.wmOut, 0.24, E.linear) : 1).toFixed(3);
  $.ln.style.opacity = (t < K.lineIn ? 1 - prog(t, K.lineOut, 0.22, E.linear) : 1).toFixed(3);
  // the tile: still at the start, leaves into the window, comes back at the end
  const tileOn = t < K.open || t >= K.fold + 0.7;
  show($.tile, tileOn);
  rectCss($.tile, TILE.rect);
  $.tileIcon.style.width = $.tileIcon.style.height = `${Math.round(TILE.size * TILE.icon)}px`;
}
