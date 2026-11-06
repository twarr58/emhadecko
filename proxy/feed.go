package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const (
	vehiclePositionsPath = "/v2/public/vehiclepositions"
	// maxStale is how long we keep serving the last good snapshot when upstream fails.
	maxStale = 60 * time.Second
)

// vehicle is a single GeoJSON feature with pre-parsed coordinates for filtering.
type vehicle struct {
	Lon, Lat  float64
	RouteType string
	Raw       json.RawMessage
}

type snapshot struct {
	Vehicles  []vehicle
	FetchedAt time.Time
}

// feed caches the full upstream vehicle feed for ttl.
type feed struct {
	url    string
	apiKey string
	ttl    time.Duration
	client *http.Client

	mu   sync.Mutex
	snap *snapshot
}

func newFeed(upstream, apiKey string, ttl time.Duration, client *http.Client) *feed {
	return &feed{url: upstream + vehiclePositionsPath, apiKey: apiKey, ttl: ttl, client: client}
}

// Get returns a fresh-enough snapshot. Concurrent callers share one upstream request.
func (f *feed) Get(ctx context.Context) (*snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.snap != nil && time.Since(f.snap.FetchedAt) < f.ttl {
		return f.snap, nil
	}
	s, err := f.fetch(ctx)
	if err != nil {
		if f.snap != nil && time.Since(f.snap.FetchedAt) < maxStale {
			return f.snap, nil
		}
		return nil, err
	}
	f.snap = s
	return s, nil
}

type upstreamError struct{ Status int }

func (e *upstreamError) Error() string { return fmt.Sprintf("upstream returned HTTP %d", e.Status) }

func (f *feed) fetch(ctx context.Context) (*snapshot, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Access-Token", f.apiKey)
	req.Header.Set("Accept", "application/json")

	res, err := f.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
		return nil, &upstreamError{Status: res.StatusCode}
	}

	var fc struct {
		Features []json.RawMessage `json:"features"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(&fc); err != nil {
		return nil, fmt.Errorf("decode upstream: %w", err)
	}

	out := make([]vehicle, 0, len(fc.Features))
	for _, raw := range fc.Features {
		var ft struct {
			Geometry struct {
				Type        string          `json:"type"`
				Coordinates json.RawMessage `json:"coordinates"`
			} `json:"geometry"`
			Properties struct {
				RouteType string `json:"route_type"`
			} `json:"properties"`
		}
		if json.Unmarshal(raw, &ft) != nil || ft.Geometry.Type != "Point" {
			continue
		}
		var c []float64
		if json.Unmarshal(ft.Geometry.Coordinates, &c) != nil || len(c) < 2 {
			continue
		}
		out = append(out, vehicle{Lon: c[0], Lat: c[1], RouteType: ft.Properties.RouteType, Raw: raw})
	}
	return &snapshot{Vehicles: out, FetchedAt: time.Now()}, nil
}
