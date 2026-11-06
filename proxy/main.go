// Command proxy is a tiny caching proxy in front of the Golemio PID API.
//
// It keeps the Golemio API key on the server (so the static frontend on
// GitHub Pages never sees it) and fetches the full vehicle feed at most once
// per CACHE_TTL, regardless of the number of connected clients. Each client
// request is then filtered by its boundingBox locally.
//
// Only GET /v2/public/vehiclepositions is exposed, so the proxy cannot be used
// to call arbitrary Golemio endpoints with our key.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := configFromEnv()
	if err != nil {
		log.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	feed := newFeed(cfg.Upstream, cfg.APIKey, cfg.CacheTTL, &http.Client{Timeout: 15 * time.Second})
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           newHandler(feed, cfg.AllowedOrigins, log),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Info("listening", "addr", cfg.ListenAddr, "upstream", cfg.Upstream, "ttl", cfg.CacheTTL.String())
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

type config struct {
	ListenAddr     string
	Upstream       string
	APIKey         string
	CacheTTL       time.Duration
	AllowedOrigins []string
}

func configFromEnv() (config, error) {
	c := config{
		ListenAddr: getenv("LISTEN_ADDR", ":8080"),
		Upstream:   strings.TrimRight(getenv("GOLEMIO_UPSTREAM", "https://api.golemio.cz"), "/"),
		APIKey:     os.Getenv("GOLEMIO_API_KEY"),
	}
	if c.APIKey == "" {
		return c, errors.New("GOLEMIO_API_KEY is required")
	}
	ttl, err := time.ParseDuration(getenv("CACHE_TTL", "5s"))
	if err != nil || ttl < time.Second {
		return c, errors.New("CACHE_TTL must be a duration >= 1s")
	}
	c.CacheTTL = ttl
	for _, o := range strings.Split(getenv("ALLOWED_ORIGINS", "*"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.AllowedOrigins = append(c.AllowedOrigins, o)
		}
	}
	return c, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
