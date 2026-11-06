package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const fixture = `{"type":"FeatureCollection","features":[
 {"type":"Feature","geometry":{"type":"Point","coordinates":[14.42,50.08]},"properties":{"route_type":"tram","gtfs_route_short_name":"22","vehicle_id":"a"}},
 {"type":"Feature","geometry":{"type":"Point","coordinates":[14.90,50.50]},"properties":{"route_type":"bus","gtfs_route_short_name":"381","vehicle_id":"b"}},
 {"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,1],[1,0],[0,0]]]},"properties":{"route_type":"bus","gtfs_route_short_name":"1","vehicle_id":"c"}}
]}`

func newTestServer(t *testing.T, status int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("X-Access-Token") != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != vehiclePositionsPath {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, fixture)
	}))
	t.Cleanup(up.Close)

	f := newFeed(up.URL, "secret", time.Minute, up.Client())
	srv := httptest.NewServer(newHandler(f, []string{"https://example.github.io"}, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func getIDs(t *testing.T, url string) (int, []string) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return res.StatusCode, nil
	}
	var fc struct {
		Features []struct {
			Properties struct {
				VehicleID string `json:"vehicle_id"`
			} `json:"properties"`
		} `json:"features"`
	}
	if err := json.NewDecoder(res.Body).Decode(&fc); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, f := range fc.Features {
		ids = append(ids, f.Properties.VehicleID)
	}
	return res.StatusCode, ids
}

func TestFilteringAndCaching(t *testing.T) {
	srv, calls := newTestServer(t, http.StatusOK)

	_, all := getIDs(t, srv.URL+vehiclePositionsPath)
	if len(all) != 2 {
		t.Fatalf("want 2 point features, got %v", all)
	}

	_, prague := getIDs(t, srv.URL+vehiclePositionsPath+"?boundingBox=50.15,14.3,50.0,14.6")
	if len(prague) != 1 || prague[0] != "a" {
		t.Fatalf("bbox filter: got %v", prague)
	}

	_, buses := getIDs(t, srv.URL+vehiclePositionsPath+"?routeType=bus")
	if len(buses) != 1 || buses[0] != "b" {
		t.Fatalf("routeType filter: got %v", buses)
	}

	if n := calls.Load(); n != 1 {
		t.Fatalf("expected 1 upstream call thanks to cache, got %d", n)
	}
}

func TestBadBBox(t *testing.T) {
	srv, _ := newTestServer(t, http.StatusOK)
	if code, _ := getIDs(t, srv.URL+vehiclePositionsPath+"?boundingBox=1,2,3"); code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", code)
	}
}

func TestUpstreamError(t *testing.T) {
	srv, _ := newTestServer(t, http.StatusTooManyRequests)
	if code, _ := getIDs(t, srv.URL+vehiclePositionsPath); code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", code)
	}
}

func TestOnlyAllowlistedPath(t *testing.T) {
	srv, _ := newTestServer(t, http.StatusOK)
	res, err := http.Get(srv.URL + "/v2/gtfs/stops")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404 for non-allowlisted path, got %d", res.StatusCode)
	}
}

func TestCORS(t *testing.T) {
	srv, _ := newTestServer(t, http.StatusOK)
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/healthz", nil)
	req.Header.Set("Origin", "https://example.github.io")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "https://example.github.io" {
		t.Fatalf("allowed origin: got %q", got)
	}

	req.Header.Set("Origin", "https://evil.example")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("disallowed origin: got %q", got)
	}
}
