package wire

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// The fixtures are parsed by the TypeScript contract tests too (judge-fixtures.test.ts). If a field
// is added on one side only, one of the two decoders refuses it.
func TestFixturesDecodeStrictlyAndRoundTrip(t *testing.T) {
	cases := map[string]func() any{
		"lease-response.json":                func() any { return &LeaseResponse{} },
		"empty-lease-response.json":          func() any { return &LeaseResponse{} },
		"complete-request.json":              func() any { return &CompleteRequest{} },
		"validation-lease-response.json":     func() any { return &ValidationLeaseResponse{} },
		"validation-complete-request.json":   func() any { return &ValidationComplete{} },
		"watermark-lease-response.json":      func() any { return &WatermarkLeaseResponse{} },
		"watermark-upload-request.json":      func() any { return &WatermarkUploadRequest{} },
		"watermark-complete-rewritten.json":  func() any { return &watermarkCompleteIn{} },
		"watermark-complete-unobserved.json": func() any { return &watermarkCompleteIn{} },
		"env-lease-response.json":            func() any { return &EnvLeaseResponse{} },
		"env-complete-request.json":          func() any { return &EnvComplete{} },
		"fail-request.json":                  func() any { return &FailRequest{} },
		"enroll-request.json":                func() any { return &EnrollRequest{} },
		"heartbeat-request.json":             func() any { return &HeartbeatRequest{} },
	}
	for name, make := range cases {
		raw, err := os.ReadFile("../../fixtures/" + name)
		if err != nil {
			t.Fatal(err)
		}
		decoded := make()
		if err := Decode(raw, decoded); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		again, err := json.Marshal(decoded)
		if err != nil {
			t.Fatal(err)
		}
		var before, after any
		if err := json.Unmarshal(raw, &before); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(again, &after); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(before, after) {
			t.Errorf("%s changed when decoded and encoded again:\n%s\n%s", name, raw, again)
		}
	}
}

func TestUnknownFieldsAndTrailingDataAreRefused(t *testing.T) {
	var out FailRequest
	if err := Decode([]byte(`{"lease_epoch":1,"error":"x","retryable":true,"extra":1}`), &out); err == nil {
		t.Error("an unknown field must be refused")
	}
	if err := Decode([]byte(`{"lease_epoch":1,"error":"x","retryable":true} {}`), &out); err == nil {
		t.Error("trailing data must be refused")
	}
	if err := Decode([]byte(`{"lease_epoch":"1"}`), &out); err == nil {
		t.Error("a wrong type must be refused")
	}
}

// WatermarkComplete carries its result as "any", which cannot be decoded strictly into; this mirror gives
// the fixtures a concrete shape to round-trip through.
type watermarkCompleteIn struct {
	LeaseEpoch int                `json:"lease_epoch"`
	Result     WatermarkRewritten `json:"result"`
}
