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
// BundleBytesMax is the control plane's bundle cap (packages/contracts/src/limits.ts BUNDLE_BYTES_MAX).
const BundleBytesMax = 64 << 20

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
		if err := c.signRequest(request, method, target, payload); err != nil {
			return nil, nil, err
		}
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

func (c *Client) signRequest(request *http.Request, method, target string, payload []byte) error {
	nonce := make([]byte, 18)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	timestamp := c.now().UnixMilli()
	nonceText := sign.Encode(nonce)
	request.Header.Set(wire.HeaderNode, c.nodeID)
	request.Header.Set(wire.HeaderTimestamp, fmt.Sprint(timestamp))
	request.Header.Set(wire.HeaderNonce, nonceText)
	request.Header.Set(wire.HeaderSignature, sign.Sign(c.key, method, target, timestamp, nonceText, payload))
	return nil
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

// LeaseValidation asks for a task-validation job (queue "validate"); the answer has its own shape.
func (c *Client) LeaseValidation(ctx context.Context, waitMS int) (*wire.ValidationJob, error) {
	var out wire.ValidationLeaseResponse
	_, _, err := c.do(ctx, http.MethodPost, "/lease", true, wire.LeaseRequest{Queue: "validate", WaitMS: waitMS}, &out)
	return out.Job, err
}

// CompleteValidation reports what the node observed; the control plane draws the conclusions.
func (c *Client) CompleteValidation(ctx context.Context, jobID string, epoch int, result wire.ValidationResult) error {
	var out wire.Accepted
	_, _, err := c.do(ctx, http.MethodPost, "/jobs/"+jobID+"/validation", true, wire.ValidationComplete{LeaseEpoch: epoch, Result: result}, &out)
	return staleOr(err)
}

// LeaseEnv asks for an environment run (queue "env"); only a node that declared Tier 2 is ever given one.
func (c *Client) LeaseEnv(ctx context.Context, waitMS int) (*wire.EnvJob, error) {
	var out wire.EnvLeaseResponse
	_, _, err := c.do(ctx, http.MethodPost, "/lease", true, wire.LeaseRequest{Queue: "env", WaitMS: waitMS}, &out)
	return out.Job, err
}

// CompleteEnv reports the signed trace of an environment run.
func (c *Client) CompleteEnv(ctx context.Context, jobID string, epoch int, trace, signature string) error {
	var out wire.Accepted
	_, _, err := c.do(ctx, http.MethodPost, "/jobs/"+jobID+"/env", true, wire.EnvComplete{LeaseEpoch: epoch, Trace: trace, TraceSignature: signature}, &out)
	return staleOr(err)
}

// LeaseWatermark asks for a delivery watermark job (queue "watermark").
func (c *Client) LeaseWatermark(ctx context.Context, waitMS int) (*wire.WatermarkJob, error) {
	var out wire.WatermarkLeaseResponse
	_, _, err := c.do(ctx, http.MethodPost, "/lease", true, wire.LeaseRequest{Queue: "watermark", WaitMS: waitMS}, &out)
	return out.Job, err
}

// WatermarkUploadTarget asks where to put a rewritten bundle of the given size.
func (c *Client) WatermarkUploadTarget(ctx context.Context, jobID string, epoch, bytes int) (wire.WatermarkUploadResponse, error) {
	var out wire.WatermarkUploadResponse
	_, _, err := c.do(ctx, http.MethodPost, "/jobs/"+jobID+"/watermark/upload", true, wire.WatermarkUploadRequest{LeaseEpoch: epoch, Bytes: bytes}, &out)
	return out, staleOr(err)
}

// PutBundle sends the rewritten bundle to the storage address the control plane named. The node's
// signature goes only to the control plane, never to storage, and the request follows no redirect.
func (c *Client) PutBundle(ctx context.Context, url string, data []byte) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	request.ContentLength = int64(len(data))
	noRedirect := *c.http
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := noRedirect.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return &Error{Status: response.StatusCode, Body: "storage refused the rewritten bundle"}
	}
	return nil
}

// CompleteWatermark reports the node's work on a watermark job.
func (c *Client) CompleteWatermark(ctx context.Context, jobID string, epoch int, result any) error {
	var out wire.Accepted
	_, _, err := c.do(ctx, http.MethodPost, "/jobs/"+jobID+"/watermark", true, wire.WatermarkComplete{LeaseEpoch: epoch, Result: result}, &out)
	return staleOr(err)
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

// FetchBundle downloads the packed bundle of a leased job. The control plane answers the signed request
// with a short-lived storage URL (302); the node's signature goes only to the control plane, never to
// storage, and neither request follows a redirect on its own. The result is at most want.Bytes long;
// the caller still checks its SHA-256.
func (c *Client) FetchBundle(ctx context.Context, jobID string, want wire.Bundle) ([]byte, error) {
	if want.Bytes <= 0 || want.Bytes > BundleBytesMax {
		return nil, fmt.Errorf("bundle size %d is outside 1..%d", want.Bytes, BundleBytesMax)
	}
	target := c.base.Path + "/bundles/" + want.SHA256 + "?job_id=" + url.QueryEscape(jobID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base.Scheme+"://"+c.base.Host+target, nil)
	if err != nil {
		return nil, err
	}
	if err := c.signRequest(request, http.MethodGet, target, nil); err != nil {
		return nil, err
	}
	noRedirect := *c.http
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	redirect, err := noRedirect.Do(request)
	if err != nil {
		return nil, err
	}
	redirect.Body.Close()
	if redirect.StatusCode == http.StatusConflict {
		return nil, ErrStaleLease
	}
	location, err := redirect.Location()
	if redirect.StatusCode != http.StatusFound || err != nil {
		return nil, &Error{Status: redirect.StatusCode, Body: "no storage address for the bundle"}
	}
	download, err := http.NewRequestWithContext(ctx, http.MethodGet, location.String(), nil)
	if err != nil {
		return nil, err
	}
	response, err := noRedirect.Do(download)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, &Error{Status: response.StatusCode, Body: "storage refused the bundle download"}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, want.Bytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > want.Bytes {
		return nil, errors.New("bundle is larger than the job says")
	}
	return data, nil
}
