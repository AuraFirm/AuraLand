// Package client talks to the control plane: every request is signed with the node's key, every
// answer is decoded strictly. It knows nothing about judging.
package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/sign"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// ResponseBytesMax bounds what the agent reads from the control plane, so a hostile or broken server
// cannot make it allocate without limit.
const ResponseBytesMax = 8 << 20

// ErrStaleLease means the control plane no longer considers this node the holder of the job (HTTP 409):
// the node must stop working on it and discard its result.
var ErrStaleLease = errors.New("the lease is no longer ours")

// Error is any other refusal.
type Error struct {
	Status int
	Body   string
}

func (e *Error) Error() string { return fmt.Sprintf("control plane answered %d: %s", e.Status, e.Body) }

type Client struct {
	base   *url.URL
	nodeID string
	key    ed25519.PrivateKey
	http   *http.Client
	now    func() time.Time
}

// New builds a client. `base` is the origin plus the API prefix, for example https://x/api/judge/v1.
func New(base, nodeID string, key ed25519.PrivateKey, httpClient *http.Client, now func() time.Time) (*Client, error) {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("control plane address %q is not a URL", base)
	}
	return &Client{base: parsed, nodeID: nodeID, key: key, http: httpClient, now: now}, nil
}

func (c *Client) do(ctx context.Context, method, path string, signed bool, body any, out any) (*http.Response, []byte, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = encode(body); err != nil {
			return nil, nil, err
		}
	}
	target := c.base.Path + path
	request, err := http.NewRequestWithContext(ctx, method, c.base.Scheme+"://"+c.base.Host+target, bytes.NewReader(payload))
	if err != nil {
		return nil, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if signed {
		nonce := make([]byte, 18)
		if _, err := rand.Read(nonce); err != nil {
			return nil, nil, err
		}
		timestamp := c.now().UnixMilli()
		nonceText := sign.Encode(nonce)
		request.Header.Set(wire.HeaderNode, c.nodeID)
		request.Header.Set(wire.HeaderTimestamp, fmt.Sprint(timestamp))
		request.Header.Set(wire.HeaderNonce, nonceText)
		request.Header.Set(wire.HeaderSignature, sign.Sign(c.key, method, target, timestamp, nonceText, payload))
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, ResponseBytesMax+1))
	if err != nil {
		return nil, nil, err
	}
	if len(data) > ResponseBytesMax {
		return nil, nil, errors.New("response is larger than the limit")
	}
	if response.StatusCode >= 400 {
		return response, data, &Error{Status: response.StatusCode, Body: truncate(string(data), 300)}
	}
	if out != nil {
		if err := wire.Decode(data, out); err != nil {
			return response, data, err
		}
	}
	return response, data, nil
}

func truncate(text string, max int) string {
	if len(text) <= max {
		return text
	}
	return text[:max]
}

// Enroll spends an enrollment token; it is the only unsigned call.
func (c *Client) Enroll(ctx context.Context, request wire.EnrollRequest) (wire.EnrollResponse, error) {
	var out wire.EnrollResponse
	_, _, err := c.do(ctx, http.MethodPost, "/enroll", false, request, &out)
	return out, err
}

func (c *Client) Heartbeat(ctx context.Context, request wire.HeartbeatRequest) (wire.HeartbeatResponse, error) {
	var out wire.HeartbeatResponse
	_, _, err := c.do(ctx, http.MethodPost, "/node/heartbeat", true, request, &out)
	return out, err
}

func (c *Client) Lease(ctx context.Context, waitMS int) (*wire.LeasedJob, error) {
	var out wire.LeaseResponse
	_, _, err := c.do(ctx, http.MethodPost, "/lease", true, wire.LeaseRequest{Queue: "judge", WaitMS: waitMS}, &out)
	return out.Job, err
}

// staleOr turns the control plane's "no longer yours" (409) on a job call into ErrStaleLease.
func staleOr(err error) error {
	var refusal *Error
	if errors.As(err, &refusal) && refusal.Status == http.StatusConflict {
		return ErrStaleLease
	}
	return err
}

func (c *Client) JobHeartbeat(ctx context.Context, jobID string, epoch int) error {
	var out wire.JobHeartbeatResponse
	_, _, err := c.do(ctx, http.MethodPost, "/jobs/"+jobID+"/heartbeat", true, wire.JobHeartbeatRequest{LeaseEpoch: epoch}, &out)
	return staleOr(err)
}

func (c *Client) Complete(ctx context.Context, jobID string, epoch int, result wire.Result) error {
	var out wire.Accepted
	_, _, err := c.do(ctx, http.MethodPost, "/jobs/"+jobID+"/complete", true, wire.CompleteRequest{LeaseEpoch: epoch, Result: result}, &out)
	return staleOr(err)
}

func (c *Client) Fail(ctx context.Context, jobID string, epoch int, reason string, retryable bool) error {
	var out wire.Accepted
	_, _, err := c.do(ctx, http.MethodPost, "/jobs/"+jobID+"/fail", true, wire.FailRequest{LeaseEpoch: epoch, Error: truncate(reason, 2000), Retryable: retryable}, &out)
	return staleOr(err)
}
