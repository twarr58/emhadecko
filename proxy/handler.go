package main

import (
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
)

type bbox struct{ North, West, South, East float64 }

func (b bbox) contains(lat, lon float64) bool {
	return lat <= b.North && lat >= b.South && lon >= b.West && lon <= b.East
}

// parseBBox parses Golemio's "topLeft.lat,topLeft.lon,bottomRight.lat,bottomRight.lon".
func parseBBox(s string) (*bbox, error) {
	if s == "" {
		return nil, nil
	}
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return nil, errors.New("boundingBox must have 4 comma separated numbers")
	}
	var v [4]float64
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return nil, fmt.Errorf("boundingBox: %w", err)
		}
		v[i] = f
	}
	b := &bbox{North: v[0], West: v[1], South: v[2], East: v[3]}
	if b.North < b.South || b.East < b.West {
		return nil, errors.New("boundingBox: expected top-left then bottom-right corner")
	}
	return b, nil
}

func newHandler(f *feed, allowedOrigins []string, log *slog.Logger) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET "+vehiclePositionsPath, func(w http.ResponseWriter, r *http.Request) {
		bb, err := parseBBox(r.URL.Query().Get("boundingBox"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		types := r.URL.Query()["routeType"]

		snap, err := f.Get(r.Context())
		if err != nil {
			log.Warn("upstream fetch failed", "err", err)
			status := http.StatusBadGateway
			var ue *upstreamError
			if errors.As(err, &ue) && ue.Status == http.StatusTooManyRequests {
				status = http.StatusTooManyRequests
			}
			http.Error(w, "upstream unavailable", status)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Last-Modified", snap.FetchedAt.UTC().Format("2006-01-02T15:04:05.000Z"))

		var out io.Writer = w
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Add("Vary", "Accept-Encoding")
			gz := gzip.NewWriter(w)
			defer gz.Close()
			out = gz
		}

		_, _ = io.WriteString(out, `{"type":"FeatureCollection","features":[`)
		first := true
		for _, v := range snap.Vehicles {
			if bb != nil && !bb.contains(v.Lat, v.Lon) {
				continue
			}
			if len(types) > 0 && !slices.Contains(types, v.RouteType) {
				continue
			}
			if !first {
				_, _ = io.WriteString(out, ",")
			}
			first = false
			_, _ = out.Write(v.Raw)
		}
		_, _ = io.WriteString(out, "]}")
	})

	return cors(allowedOrigins, mux)
}

func cors(allowed []string, next http.Handler) http.Handler {
	allowAll := slices.Contains(allowed, "*")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		switch {
		case allowAll:
			w.Header().Set("Access-Control-Allow-Origin", "*")
		case origin != "" && slices.Contains(allowed, origin):
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Expose-Headers", "X-Last-Modified")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
