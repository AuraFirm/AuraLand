package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/sign"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

func keys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return public, private
}

// A control plane that verifies exactly what the TypeScript side verifies, so a mistake in what the
// client signs fails here rather than on a real node.
func verifying(t *testing.T, public ed25519.PublicKey, handler func(w http.ResponseWriter, body []byte)) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		timestamp, _ := strconv.ParseInt(r.Header.Get(wire.HeaderTimestamp), 10, 64)
		signature, err := base64.RawURLEncoding.DecodeString(r.Header.Get(wire.HeaderSignature))
		target := r.URL.Path
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		text := sign.Canonical(r.Method, target, timestamp, r.Header.Get(wire.HeaderNonce), body)
		if err != nil || !ed25519.Verify(public, []byte(text), signature) || r.Header.Get(wire.HeaderNode) != "nod_test" {
			http.Error(w, `{"title":"Authentication required"}`, http.StatusUnauthorized)
			return
		}
		handler(w, body)
	}))
}

func TestRequestsAreSignedAndAnswersDecodedStrictly(t *testing.T) {
	public, private := keys(t)
	server := verifying(t, public, func(w http.ResponseWriter, body []byte) {
		w.Write([]byte(`{"state":"active"}`))
	})
	defer server.Close()
	c, err := New(server.URL+"/api/judge/v1", "nod_test", private, server.Client(), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	out, err := c.Heartbeat(context.Background(), wire.HeartbeatRequest{AgentVersion: "0.1.0", CanaryOK: true})
	if err != nil || out.State != "active" {
		t.Fatalf("%+v %v", out, err)
	}
	other, _ := New(server.URL+"/api/judge/v1", "nod_test", func() ed25519.PrivateKey { _, k := keys(t); return k }(), server.Client(), time.Now)
	if _, err := other.Heartbeat(context.Background(), wire.HeartbeatRequest{AgentVersion: "0.1.0"}); err == nil {
		t.Fatal("a request signed with the wrong key must be refused")
	}
}

func TestAnswerWithAnUnknownFieldIsRefused(t *testing.T) {
	public, private := keys(t)
	server := verifying(t, public, func(w http.ResponseWriter, _ []byte) { w.Write([]byte(`{"state":"active","extra":1}`)) })
	defer server.Close()
	c, _ := New(server.URL+"/api/judge/v1", "nod_test", private, server.Client(), time.Now)
	if _, err := c.Heartbeat(context.Background(), wire.HeartbeatRequest{AgentVersion: "0.1.0"}); err == nil {
		t.Fatal("a response with a field we do not know must be refused")
	}
}

func TestAConflictOnAJobCallMeansTheLeaseIsLost(t *testing.T) {
	public, private := keys(t)
	server := verifying(t, public, func(w http.ResponseWriter, _ []byte) { http.Error(w, "{}", http.StatusConflict) })
	defer server.Close()
	c, _ := New(server.URL+"/api/judge/v1", "nod_test", private, server.Client(), time.Now)
	if err := c.JobHeartbeat(context.Background(), "job_1", 1); !errors.Is(err, ErrStaleLease) {
		t.Fatalf("heartbeat: %v", err)
	}
	if err := c.Complete(context.Background(), "job_1", 1, wire.Result{Tests: []wire.TestResult{}}); !errors.Is(err, ErrStaleLease) {
		t.Fatalf("complete: %v", err)
	}
	if err := c.Fail(context.Background(), "job_1", 1, "x", true); !errors.Is(err, ErrStaleLease) {
		t.Fatalf("fail: %v", err)
	}
	// A 409 on a lease request means "this node is not active", which is not a stale lease.
	if _, err := c.Lease(context.Background(), 0); errors.Is(err, ErrStaleLease) || err == nil {
		t.Fatalf("lease: %v", err)
	}
}

func TestOversizedAnswersAreRefused(t *testing.T) {
	public, private := keys(t)
	server := verifying(t, public, func(w http.ResponseWriter, _ []byte) {
		w.Write(make([]byte, ResponseBytesMax+10))
	})
	defer server.Close()
	c, _ := New(server.URL+"/api/judge/v1", "nod_test", private, server.Client(), time.Now)
	if _, err := c.Heartbeat(context.Background(), wire.HeartbeatRequest{AgentVersion: "0.1.0"}); err == nil {
		t.Fatal("an answer over the limit must be refused")
	}
}

func TestEveryRequestUsesAFreshNonce(t *testing.T) {
	public, private := keys(t)
	seen := map[string]bool{}
	server := verifying(t, public, func(w http.ResponseWriter, _ []byte) { w.Write([]byte(`{"state":"active"}`)) })
	defer server.Close()
	original := server.Client().Transport
	counting := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		seen[r.Header.Get(wire.HeaderNonce)] = true
		return original.RoundTrip(r)
	})}
	c, _ := New(server.URL+"/api/judge/v1", "nod_test", private, counting, time.Now)
	for i := 0; i < 5; i++ {
		if _, err := c.Heartbeat(context.Background(), wire.HeartbeatRequest{AgentVersion: "0.1.0"}); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 5 {
		t.Fatalf("%d distinct nonces for 5 requests", len(seen))
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Goal: the bundle download signs only the request to the control plane, follows the storage address
// by hand, and never accepts more bytes than the job announced. Method: a control plane that verifies
// the signature and redirects to a second server that must see no node headers.
func TestFetchBundleSendsTheSignatureOnlyToTheControlPlane(t *testing.T) {
	public, private := keys(t)
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(wire.HeaderSignature) != "" || r.Header.Get(wire.HeaderNode) != "" {
			t.Error("the node's signature must never reach storage")
		}
		w.Write([]byte("0123456789"))
	}))
	defer storage.Close()
	plane := verifying(t, public, func(w http.ResponseWriter, _ []byte) {
		w.Header().Set("Location", storage.URL+"/object?sig=x")
		w.WriteHeader(http.StatusFound)
	})
	defer plane.Close()
	c, _ := New(plane.URL+"/api/judge/v1", "nod_test", private, plane.Client(), time.Now)
	data, err := c.FetchBundle(context.Background(), "job_x", wire.Bundle{SHA256: "ab", Bytes: 10})
	if err != nil || string(data) != "0123456789" {
		t.Fatalf("%q %v", data, err)
	}
	if _, err := c.FetchBundle(context.Background(), "job_x", wire.Bundle{SHA256: "ab", Bytes: 9}); err == nil {
		t.Fatal("a body larger than announced must be refused")
	}
	if _, err := c.FetchBundle(context.Background(), "job_x", wire.Bundle{SHA256: "ab", Bytes: 0}); err == nil {
		t.Fatal("a zero size must be refused")
	}
}
