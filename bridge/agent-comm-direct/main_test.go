package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDirectLoopbackRoundTrip(t *testing.T) {
	dir := t.TempDir()
	var input bytes.Buffer
	const alicePayload = "{\"display\":\"周二 09:00\"}\n  "
	const bobPayload = " {\"accepted\":true} "
	requests := []request{
		{ID: "alice-send", From: "Alice", Payload: alicePayload},
		{ID: "bob-reply", From: "Bob", Payload: bobPayload},
		{ID: "alice-send", From: "Alice", Payload: alicePayload},
		{ID: "alice-send", From: "Alice", Payload: "substituted"},
		{ID: "unknown", From: "Mallory", Payload: "spoofed"},
		{ID: "alice-next", From: "Alice", Payload: "a fresh operation"},
	}
	for _, request := range requests {
		if err := json.NewEncoder(&input).Encode(request); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	if err := run(context.Background(), dir, &input, &output); err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(&output)
	var startup struct {
		Ready bool
		Peers map[string]peerInfo
	}
	if err := dec.Decode(&startup); err != nil || !startup.Ready || len(startup.Peers) != 2 {
		t.Fatalf("invalid readiness: %+v, %v", startup, err)
	}
	alice, bob := startup.Peers["Alice"], startup.Peers["Bob"]
	if alice.URN == bob.URN || alice.PeerID == bob.PeerID || alice.Address == bob.Address {
		t.Fatal("endpoints share an identity or address")
	}
	for _, peer := range []peerInfo{alice, bob} {
		if !strings.HasPrefix(peer.Address, "/ip4/127.0.0.1/tcp/") || peer.PeerID == "" || peer.URN == "" {
			t.Fatalf("unexpected endpoint: %+v", peer)
		}
	}
	for i, request := range requests {
		var got response
		if err := dec.Decode(&got); err != nil {
			t.Fatal(err)
		}
		want := response{ID: request.ID, OK: true, Payload: request.Payload}
		if i == 3 || i == 4 {
			want = response{ID: request.ID, Code: directProtocol}
		}
		if got != want {
			t.Fatalf("response %d: got %+v, want %+v", i, got, want)
		}
	}
	if err := dec.Decode(new(response)); err != io.EOF {
		t.Fatalf("unexpected extra output: %v", err)
	}
	for _, endpoint := range []string{"alice", "bob"} {
		path := filepath.Join(dir, endpoint, "receipts")
		receipts, err := os.ReadDir(path)
		if err != nil || len(receipts) != 1 {
			t.Fatalf("%s has %d receipts, %v", endpoint, len(receipts), err)
		}
		data, err := os.ReadFile(filepath.Join(path, receipts[0].Name()))
		if err != nil || len(data) != 96 {
			t.Fatalf("%s receipt does not contain only the wire ID and payload digest: %v", endpoint, err)
		}
	}
}
