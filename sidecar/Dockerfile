FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.26-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /calshare .

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/paulmascarilla/opencloud-calendar-share" \
      org.opencontainers.image.description="calshare: calendar sharing and event invitations for OpenCloud + Radicale" \
      org.opencontainers.image.licenses="AGPL-3.0"
COPY --from=build /calshare /calshare
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/calshare"]
