# Installation

Requirements: OpenCloud ≥ 8.1.

| OpenCloud installed with | How |
|---|---|
| [opencloud-compose](https://github.com/opencloud-eu/opencloud-compose) (Docker Compose) | [the Compose overlay](#docker-compose) |
| Kubernetes, plain manifests | [Helm chart](#kubernetes-helm), `opencloud.patch.enabled=true`: fully automatic |
| Kubernetes, community Helm charts ([archived](https://github.com/opencloud-eu/helm)) | Helm chart, then [two manual steps](#wiring-opencloud) |
| Bare metal, Raspberry Pi | not packaged yet: the pieces are the same as in the Compose overlay |

## Docker Compose

Requirements: Docker Compose 2.23.1+. `deploy/compose/calendar.yml` (also attached to each release, with
the matching version) adds Radicale, the calshare sidecar, the proxy routes and the web extension to
opencloud-compose. It **replaces** `radicale/radicale.yml`: it uses the same data volume (`radicale-data` or
`RADICALE_DATA_DIR`), so calendars of an existing Radicale are kept.

```sh
cd opencloud-compose
mkdir -p calendar && curl -fsSL -o calendar/calendar.yml \
  https://github.com/paulmascarilla/opencloud-calendar-share/releases/latest/download/calendar.yml
# in .env: add calendar/calendar.yml to COMPOSE_FILE (and remove radicale/radicale.yml), e.g.
#   COMPOSE_FILE=docker-compose.yml:traefik/opencloud.yml:calendar/calendar.yml
echo "CALENDAR_PROXY_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d
```

Then open **Calendar** in OpenCloud's app menu. CalDAV clients use `https://<OC_DOMAIN>/caldav/`.

| `.env` variable | Default | |
|---|---|---|
| `CALENDAR_PROXY_SECRET` | (required) | shared by the OpenCloud proxy and calshare, see [Security](#security) |
| `CALENDAR_VERSION` | the release's version | tag of the `calshare` and `web` images |
| `CALENDAR_LANGUAGE` | `en` | language of the texts added to invitations (`en`, `fr`) |
| `CALENDAR_AUTO_ACCEPT` | `true` | shared calendars appear at once for the recipient |
| `CALENDAR_SERVICE_AUTH` | `""` | `user:app-token` of the [service account](#service-account) (`docker compose exec opencloud opencloud auth-app create …`) |
| `CALENDAR_OPENCLOUD_URL` | `http://opencloud:9200` | OpenCloud as calshare reaches it (Graph API) |
| `RADICALE_DOCKER_TAG` | `v3.8.1` | |

The public URL of invitation links is built from `OC_DOMAIN` (and `TRAEFIK_PORT_HTTPS`), like OpenCloud's own.

- **Proxy routes.** The overlay mounts its own `/etc/opencloud/proxy.yaml` (the `calendar-proxy` config at the end
  of the file), in place of `config/opencloud/proxy.yaml`. It keeps that file's `/yjs` route. Add any other
  route of yours there.
- **Isolation.** Radicale and calshare share one network namespace, like the containers of a pod: Radicale only
  listens on `127.0.0.1`. They are only attached to the internal network `calendar-net`, together with
  OpenCloud. This replaces the Kubernetes NetworkPolicy.
- **Podman.** Use a log driver podman knows (`LOG_DRIVER=k8s-file`). When Radicale must be recreated (new
  `RADICALE_DOCKER_TAG`), run `docker compose down` first: podman refuses to recreate a container that calshare
  shares the network of.
- **Uninstall.** Remove `calendar/calendar.yml` from `COMPOSE_FILE` and put `radicale/radicale.yml` back (or
  nothing), then `docker compose up -d --remove-orphans`. The `radicale-data` volume is kept.

## Kubernetes (Helm)

Requirements: Helm 3.8+.

```sh
helm install calendar oci://ghcr.io/paulmascarilla/charts/opencloud-calendar-share --version <x.y.z> \
  -n opencloud \
  --set fullnameOverride=calendar \
  --set calshare.publicUrl=https://cloud.example.com \
  --set calshare.serviceAccount.existingSecret=calshare-service \
  --set opencloud.patch.enabled=true
helm test calendar -n opencloud --logs
```

### Values

The full list is in [`values.yaml`](../charts/opencloud-calendar-share/values.yaml).

| Value | Default | |
|---|---|---|
| `calshare.publicUrl` | `""` | public OpenCloud URL, used in the Accept / Maybe / Decline links of invitations |
| `calshare.language` | `en` | language of the texts added to invitations (`en`, `fr`) |
| `calshare.opencloudUrl` | `https://opencloud:9200` | in-cluster OpenCloud URL (Graph API) |
| `calshare.opencloudInsecure` | `false` | skip TLS verification of `opencloudUrl` (self-signed certificates) |
| `calshare.autoAccept` | `true` | shared calendars appear at once for the recipient |
| `calshare.serviceAccount.existingSecret` | `""` | Secret (`auth` = `user:app-token`) of a plain OpenCloud user, for invitations created in CalDAV clients |
| `radicale.persistence.existingClaim` | `""` | reuse an existing Radicale volume (otherwise a PVC is created, and kept on uninstall) |
| `radicale.predefinedCollections` | Contacts, Calendar, Tasks | collections created at a user's first connection |
| `radicale.extraConfig` | `""` | appended to the Radicale configuration (INI) |
| `opencloud.patch.enabled` | `false` | wire OpenCloud automatically (see below) |
| `opencloud.proxy.extraRoutes` | `[]` | other proxy routes to keep in the generated `proxy.yaml` |
| `networkPolicy.enabled` | `true` | only OpenCloud pods (`opencloud.podSelector`) may reach Radicale / calshare |
| `podSecurityContext`, `containerSecurityContext` | non-root, RuntimeDefault seccomp, no capabilities, read-only root | security contexts of the pod and both containers |
| `imagePullSecrets` | `[]` | for private packages |

### Wiring OpenCloud

OpenCloud needs the proxy routes (`/caldav`, `/carddav`, `/calshare`) and the web extension. The chart always
renders the routes into Secret `<release>-opencloud-proxy` (in `opencloud.namespace`). It is a Secret because the
routes carry the proxy secret (see [Security](#security)).

**OpenCloud deployed with plain manifests:** set `opencloud.patch.enabled=true`. A Job adds the extension's init
container to the OpenCloud Deployment and mounts the proxy config. It uses the official kubectl image, with RBAC
limited to `get`/`patch` on that one Deployment. OpenCloud restarts once. The extension goes in a sub-folder of
the apps directory, so other extensions are left alone.

- The chart takes over `/etc/opencloud/proxy.yaml`. Put any other routes in `opencloud.proxy.extraRoutes`.
- `helm uninstall` removes exactly what was added. Afterwards OpenCloud has no `proxy.yaml` mounted any more:
  remount your own if you had one.

**OpenCloud deployed with the community Helm charts:** they cannot take extra routes or extensions (their
`webExtensions` list is fixed), and the repository is archived. The patch Job would be undone by their next
`helm upgrade`.
- Mount Secret `<release>-opencloud-proxy` as `/etc/opencloud/proxy.yaml`, or merge its routes into yours while
  keeping their `X-Calshare-Secret` header.
- Copy `/usr/share/nginx/html/calendar/` from the `web` image into OpenCloud's apps directory
  (`WEB_ASSET_APPS_PATH/calendar`). The image has the same layout as the official `opencloudeu/web-extensions`
  images. You can also unzip the release's `calendar-<version>.zip` there.

`NOTES.txt`, shown after install, prints these steps for your release.

## Service account

This is optional. It enables invitations created in CalDAV clients (see [invitations](invitations.md)).
It is a plain, non-admin OpenCloud user, because searching users by e-mail does not need admin rights:

```sh
# create the user "calshare-bot" (admin UI or Graph API), then:
kubectl -n opencloud exec deploy/opencloud -- opencloud auth-app create --user-name=calshare-bot --expiration=8760h
kubectl -n opencloud create secret generic calshare-service --from-literal=auth=calshare-bot:<token>
# then: --set calshare.serviceAccount.existingSecret=calshare-service
```

The token is valid for one year. To rotate it, create a new token, update the Secret, and run
`kubectl -n opencloud rollout restart deploy/<release>`.

With Docker Compose: `docker compose exec opencloud opencloud auth-app create --user-name=calshare-bot
--expiration=8760h`, then `CALENDAR_SERVICE_AUTH=calshare-bot:<token>` in `.env` and `docker compose up -d`.

## Private packages

Packages published from a private GitHub repository are private. Either make them public in the repository's
package settings, or:

```sh
helm registry login ghcr.io -u <user>            # to pull the chart
kubectl -n opencloud create secret docker-registry ghcr --docker-server=ghcr.io \
  --docker-username=<user> --docker-password=<token with read:packages>
# then: --set imagePullSecrets[0].name=ghcr
```

When `opencloud.patch.enabled` is set, the OpenCloud pod pulls the `web` image too: add the pull secret there as well.

## Security

Radicale and calshare trust the `X-Remote-User` header set by the OpenCloud proxy. So that nothing else can send it:

- **Proxy secret.** The chart generates a secret (Secret `<release>-proxy-secret`, kept across upgrades); with
  Compose it is `CALENDAR_PROXY_SECRET`. The OpenCloud proxy adds it to every request it forwards (`X-Calshare-Secret`). calshare refuses requests without it
  (401), except `/healthz`.
- **CalDAV gate.** Radicale only listens on `127.0.0.1` in its pod. The Service's CalDAV port leads to a gate in
  calshare, which checks the secret, removes it, and forwards to Radicale.
- **NetworkPolicy** (on by default; with Compose, the internal network `calendar-net`): only OpenCloud pods (`opencloud.podSelector`) and `helm test` may reach the
  pod. It needs a CNI that enforces NetworkPolicies; the secret protects you even without one.
- **Invitations.** Only the owner of a calendar, or a user it is shared with for writing, may send invitations
  from it. Guests see the organizer's name from OpenCloud, not the one written in the event, when the service
  account is set.

To rotate the secret, delete Secret `<release>-proxy-secret` and run `helm upgrade`: OpenCloud and calshare
restart with a new one. With Compose, change `CALENDAR_PROXY_SECRET` and run `docker compose up -d`.

Upgrading from 0.1.x: the proxy config moves from a ConfigMap to a Secret. With `opencloud.patch.enabled` the
Job remounts it. Otherwise, mount the new Secret before upgrading calshare, or CalDAV and the web app get 401.
Upgrade with your own values file (`-f`) rather than `--reuse-values`, which would keep the old defaults
(NetworkPolicy off, no security contexts).

## Migrating from the plain manifests in `k8s/`

1. Remove the manual changes from the OpenCloud Deployment: the `web-app-calendar` init container, the
   `web-apps` volume and its mount, and `WEB_ASSET_APPS_PATH`.
2. Delete `deploy/radicale`, `svc/radicale` and `cm/radicale-config`. Keep PVC `radicale-data` and Secret
   `calshare-service`.
3. Install with `--set radicale.persistence.existingClaim=radicale-data`. The sidecar finds the existing
   calendars, shares and invitations.

The manifests in `k8s/` predate the proxy secret and the CalDAV gate: they leave Radicale and calshare open to
anything that can reach them.
