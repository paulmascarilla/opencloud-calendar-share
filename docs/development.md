# Development

## Build and run on kind

Build local images (podman), load them into kind, then install the chart from the working tree:

```sh
podman build -t ghcr.io/paulmascarilla/opencloud-calendar-share/calshare:0.1.0 sidecar/
podman build -t ghcr.io/paulmascarilla/opencloud-calendar-share/web:0.1.0 web-extension/
for i in calshare web; do
  podman save ghcr.io/paulmascarilla/opencloud-calendar-share/$i:0.1.0 -o /tmp/$i.tar
  kind load image-archive /tmp/$i.tar --name <cluster>
done
helm upgrade --install calendar charts/opencloud-calendar-share -n opencloud --set fullnameOverride=calendar \
  --set calshare.publicUrl=https://localhost:9200 --set calshare.opencloudInsecure=true --set opencloud.patch.enabled=true
```

When you rebuild with the same tag, delete the pods (or restart OpenCloud for the web image): the pull policy is
`IfNotPresent`.

Web extension only: `cd web-extension && pnpm install && pnpm build:w`, and mount `dist/` as
`<apps directory>/calendar` in OpenCloud.

`k8s/` holds the original plain manifests (Radicale + sidecar, proxy ConfigMap, OpenCloud patch), kept as a reference.
They lack the proxy secret and the CalDAV gate: don't use them as they are.

## Tests

The sidecar tests need no cluster:

```sh
cd sidecar && go test -race ./...
```

The end-to-end scripts below run against a live OpenCloud. Prerequisites:
- OpenCloud on `https://localhost:9200` (port-forward), or another URL in `OC`;
- test users `alice`, `bob` and `admin`, with e-mails `<user>@example.org`;
- a `tokens.env` file with their app tokens (`alice=…`), created with
  `opencloud auth-app create --user-name=<user> --expiration=3h` (or their passwords, with
  `PROXY_ENABLE_BASIC_AUTH=true`).

To test the Compose overlay: clone opencloud-compose, copy `deploy/compose/calendar.yml` to `calendar/`, and in
`.env` set `COMPOSE_FILE=docker-compose.yml:calendar/calendar.yml:custom/test.yml`, `CALENDAR_PROXY_SECRET`,
`PROXY_ENABLE_BASIC_AUTH=true`, `INITIAL_ADMIN_PASSWORD` and `CALENDAR_VERSION` (a local image tag). In
`custom/test.yml`, publish OpenCloud's port: `ports: ["127.0.0.1:9400:9200"]` with `PROXY_HTTP_ADDR: 0.0.0.0:9200`.
Create `alice` and `bob` through the Graph API, then run the scripts with `OC=http://localhost:9400`.

| Test | Covers |
|---|---|
| `sidecar`: `go test -race ./...` | the whole sidecar against an in-memory Radicale and Graph: sharing, invitations, moves, time zones, CalDAV-client invitations, guest edits and proposals, catch-up scan, free/busy |
| `test/e2e.sh` | calendar sharing through the proxy |
| `test/invitations-e2e.sh` | invitations: delivery, answers, moves, time zones, CalDAV-client invitations, clients dropping markers (31 checks) |
| `web-extension`: `pnpm test:integration` | iCalendar logic against the live server |
| `web-extension/test/ui-*.mjs` | headless Chromium (playwright-core): calendar, editing edge cases, invitation dates, proposals, invitations, answer links, notifications, availability, design and auto-refresh |

```sh
TOKENS_FILE=tokens.env test/invitations-e2e.sh
cd web-extension && CHROMIUM=/snap/bin/chromium TOKENS_FILE=../tokens.env node test/ui-notifications.mjs /tmp/shots
```

The browser tests target the week of 19–25 Oct 2026 (`ui-availability.mjs`: 26 Oct–1 Nov, after the DST change).

## Release

Run the `tag` workflow on `main` (Actions → tag → Run workflow, or `gh workflow run tag.yaml`). It picks the next
version from the commits since the latest tag (breaking change: major, or minor before 1.0.0; `feat`: minor; anything
else: patch), unless you choose the bump. It then prepends the changelog to `CHANGELOG.md`, commits
`chore: release vX.Y.Z`, tags `vX.Y.Z` and starts the release. With `dry-run`, it only shows the version and the
changelog in the run summary. Preview locally with `.github/scripts/changelog.sh version` and
`.github/scripts/changelog.sh notes <version>`.

Pushing a tag `vX.Y.Z` by hand also works. `.github/workflows/release.yaml` then:
- publishes both images (linux/amd64 + arm64);
- pushes the chart (version = tag) to `oci://ghcr.io/<owner>/charts`;
- creates a GitHub release, with the changelog since the previous tag as notes, with the chart, the web extension zip and the Compose overlay (`calendar.yml`, version = tag).

`.github/workflows/ci.yaml` checks every push: sidecar (gofmt, vet, tests), type-check and build of the extension, chart lint,
Compose overlay (`docker compose config` on top of opencloud-compose), image builds.
`.github/workflows/lint.yaml` runs on pull requests and pushes to `main`: commit messages and pull request title
(Conventional Commits), yamllint, golangci-lint, ESLint and ShellCheck.
