FROM --platform=$BUILDPLATFORM docker.io/library/node:22-alpine AS build
WORKDIR /src
RUN npm install -g pnpm@11.0.9
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Same layout as the official opencloudeu/web-extensions images: /usr/share/nginx/html/<app>/.
# Default command copies the app to $TARGET (init container usage, see k8s/ and the Helm chart).
FROM docker.io/library/busybox:1.37
LABEL org.opencontainers.image.source="https://github.com/paulmascarilla/opencloud-calendar-share" \
      org.opencontainers.image.description="OpenCloud Web calendar extension (opencloud-calendar-share)" \
      org.opencontainers.image.licenses="AGPL-3.0"
COPY --from=build /src/dist /usr/share/nginx/html/calendar
ENV TARGET=/web-apps/calendar
ENTRYPOINT ["sh", "-c", "mkdir -p \"$TARGET\" && rm -rf \"$TARGET\"/* && cp -R /usr/share/nginx/html/calendar/. \"$TARGET\"/"]
