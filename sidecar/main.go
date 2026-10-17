package main

import (
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
	_ "time/tzdata" // TZID lookups without system zoneinfo
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "check" {
		os.Exit(check(os.Args[2:]))
	}
	level := map[string]slog.Level{"DEBUG": slog.LevelDebug, "INFO": slog.LevelInfo, "WARNING": slog.LevelWarn,
		"WARN": slog.LevelWarn, "ERROR": slog.LevelError, "CRITICAL": slog.LevelError}[strings.ToUpper(env("LOG_LEVEL", "INFO"))]
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))

	cfg := ConfigFromEnv()
	server, err := NewServer(cfg)
	if err != nil {
		slog.Error("cannot start", "err", err)
		os.Exit(1)
	}
	slog.Info(fmt.Sprintf("listening on %s (base path %s, radicale %s, auto-accept %v)",
		cfg.Listen, quoteString(cfg.BasePath), cfg.RadicaleURL, cfg.AutoAccept))
	if cfg.OCServiceAuth == "" {
		slog.Warn("OC_SERVICE_AUTH unset: guests added by e-mail in CalDAV clients will not be invited, " +
			"organizer names come from the events")
	}
	if cfg.ProxySecret == "" {
		slog.Warn("PROXY_SECRET unset: any client that reaches this pod can act as any user (X-Remote-User)")
	}
	// Listen before the agent's first scan: its writes come back through the storage hook.
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		slog.Error("cannot listen", "err", err)
		os.Exit(1)
	}
	server.agent.Start()
	if cfg.CalDAVListen != "" {
		slog.Info(fmt.Sprintf("CalDAV gate on %s -> %s", cfg.CalDAVListen, cfg.RadicaleURL))
		// No write timeout: large calendars and sync reports may stream for a while.
		gate := &http.Server{Addr: cfg.CalDAVListen, Handler: server.CalDAVGate(), ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout: 5 * time.Minute, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 64 << 10}
		go func() {
			slog.Error("CalDAV gate stopped", "err", gate.ListenAndServe())
			os.Exit(1)
		}()
	}
	srv := &http.Server{Handler: server, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: time.Minute,
		WriteTimeout: 2 * time.Minute, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 64 << 10}
	if err := srv.Serve(listener); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

// check is the image's self-test (helm test): calshare check <healthz URL> [host:port ...]
func check(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: calshare check <healthz URL> [host:port ...]")
		return 2
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	fmt.Println(string(body))
	if resp.StatusCode != 200 {
		return 1
	}
	for _, addr := range args[1:] {
		conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		conn.Close()
		fmt.Println(addr, "reachable")
	}
	return 0
}
