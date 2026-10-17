# Launch film

The demo in the main README (`docs/assets/demo.mp4`, `demo.gif`): a 46 s silent film of the calendar app, built in
code. Every frame is a function of time (`seek(t)`) in `src/`, drawn from real captures of the app, then rendered
to MP4 in headless Chrome. `brief.md` holds the brief, the beat-by-beat structure and the current status.

## Skill to install

The film is built and rendered with the **motion-designer** skill for [Claude Code](https://claude.com/claude-code)
(MIT, [kaventro/motion-designer](https://github.com/kaventro/motion-designer)). In Claude Code:

```
/plugin marketplace add kaventro/motion-designer
/plugin install motion-designer@motion-designer
```

It brings the film engine, the checks and the render scripts. Then ask Claude for a change to the film, for example
"in the launch film, hold the invitation page one beat longer": the skill reads `brief.md` and picks up from there.

Tools it needs: Node.js 22, Python 3, `ffmpeg`, and Chrome or Chromium. To check them:

```sh
bash ~/.claude/plugins/cache/motion-designer/motion-designer/*/skills/motion-designer/scripts/doctor.sh
```

With Chromium from snap, set `CHROME=/snap/bin/chromium` for every script below.

## Preview, check, render

`SKILL_DIR` is the skill's folder: `~/.claude/plugins/cache/motion-designer/motion-designer/<version>/skills/motion-designer`.

```sh
# preview and scrub: open src/index.html in Chrome
node $SKILL_DIR/scripts/check.mjs src/index.html          # deterministic, no errors, the loop closes
node $SKILL_DIR/scripts/render.mjs video src/index.html out/demo.mp4
node $SKILL_DIR/scripts/render.mjs verify src/index.html out/demo.mp4
```

On a machine short on memory (the kind cluster running alongside), render in chunks with `--from` / `--to`
(e.g. 0–12, 12–24, 24–36, 36–46.2) and join them with `ffmpeg -f concat -c copy`.

Then publish it next to the main README:

```sh
ffmpeg -i out/demo.mp4 -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -movflags +faststart -an ../assets/demo.mp4
ffmpeg -i ../assets/demo.mp4 -vf "fps=16,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" ../assets/demo.gif
```

## Recapture the app

The screens come from the real app in a local cluster ([development](../development.md)), with fictional demo
users and events:

```sh
OC=https://localhost:9200 NS=opencloud tools/seed.sh     # demo users, calendars, events; writes tools/tokens.env (git-ignored)
CHROME=/snap/bin/chromium node tools/capture.mjs          # 2x screenshots + element rects in assets/capture/
tools/cleanup.sh                                          # deletes the demo data and the tokens
```

The raw PNG captures stay out of git. The film uses their WebP copies in `assets/img/`, packed with the font and the
icon into `src/assets.js`, and the rects in `assets/capture/rects.json` (copied into `src/rects.js`).

## Files

| Path | What |
|---|---|
| `brief.md` | brief, structure, status |
| `src/` | the film: `index.html`, `scenes.js` (the story, beat by beat), `core.js`, `device.js`, `fx.js`, `film.css`, `assets.js`, `rects.js` |
| `assets/` | captures, WebP screens, Inter, the app icon (`img/icon-app.svg`, same art as `docs/assets/icon.svg`) |
| `tools/` | demo data, capture and cleanup scripts |
| `out/` | renders (git-ignored) |
