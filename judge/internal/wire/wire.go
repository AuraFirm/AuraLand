// Package wire holds the messages exchanged with the control plane (docs/kit/06 section 7). It
// mirrors packages/contracts/src/judge-protocol.ts by hand; the JSON files in judge/fixtures are
// parsed by both sides, and decoding here rejects unknown fields, exactly as the server does.
package wire

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	HeaderNode      = "X-Aura-Node"
	HeaderTimestamp = "X-Aura-Timestamp"
	HeaderNonce     = "X-Aura-Nonce"
	HeaderSignature = "X-Aura-Signature"
)

type EnrollRequest struct {
	Token        string `json:"token"`
	Name         string `json:"name"`
	PublicKey    string `json:"public_key"`
	AgentVersion string `json:"agent_version"`
	Tiers        []int  `json:"tiers"`
}

type EnrollResponse struct {
	NodeID string `json:"node_id"`
	State  string `json:"state"`
}

type HeartbeatRequest struct {
	AgentVersion string `json:"agent_version"`
	CanaryOK     bool   `json:"canary_ok"`
	RunningJobs  int    `json:"running_jobs"`
}

type HeartbeatResponse struct {
	State string `json:"state"`
}

type LeaseRequest struct {
	Queue  string `json:"queue"`
	WaitMS int    `json:"wait_ms"`
}

type LeaseResponse struct {
	Job *LeasedJob `json:"job"`
}

type LeasedJob struct {
	JobID      string     `json:"job_id"`
	LeaseEpoch int        `json:"lease_epoch"`
	LeaseTTLS  int        `json:"lease_ttl_s"`
	Kind       string     `json:"kind"`
	Submission Submission `json:"submission"`
	Task       Task       `json:"task"`
}

type Submission struct {
	ID       string `json:"id"`
	Language string `json:"language"`
	Source   string `json:"source"`
}

type Task struct {
	VersionID string `json:"version_id"`
	Bundle    Bundle `json:"bundle"`
	Spec      Spec   `json:"spec"`
}

type Bundle struct {
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type Spec struct {
	SpecVersion    int        `json:"spec_version"`
	Kind           string     `json:"kind"`
	Title          string     `json:"title"`
	TimeLimitMS    int        `json:"time_limit_ms"`
	MemoryLimitKiB int        `json:"memory_limit_kib"`
	OutputLimitKiB int        `json:"output_limit_kib"`
	Languages      []string   `json:"languages"`
	Scoring        Scoring    `json:"scoring"`
	Tests          []TestSpec `json:"tests"`
	Checker        Checker    `json:"checker"`
	Interactive    bool       `json:"interactive"`
	License        License    `json:"license"`
	Provenance     Provenance `json:"provenance"`
}

type Scoring struct {
	Type     string    `json:"type"`
	Subtasks []Subtask `json:"subtasks"`
}

type Subtask struct {
	Group  string  `json:"group"`
	Points float64 `json:"points"`
}

type TestSpec struct {
	ID       string  `json:"id"`
	Group    string  `json:"group"`
	Points   float64 `json:"points"`
	IsSample bool    `json:"is_sample"`
}

type Checker struct {
	Type string `json:"type"`
}

type License struct {
	Owner string `json:"owner"`
	Terms string `json:"terms"`
}

type Provenance struct {
	Author          string   `json:"author"`
	Reviewers       []string `json:"reviewers"`
	Created         string   `json:"created"`
	GeneratedWithAI bool     `json:"generated_with_ai"`
}

type JobHeartbeatRequest struct {
	LeaseEpoch int `json:"lease_epoch"`
}

type JobHeartbeatResponse struct {
	LeaseTTLS int `json:"lease_ttl_s"`
}

type TestResult struct {
	TestID     string `json:"test_id"`
	Verdict    string `json:"verdict"`
	CPUMS      int    `json:"cpu_ms"`
	WallMS     int    `json:"wall_ms"`
	MemoryKiB  int    `json:"memory_kib"`
	CheckerMsg string `json:"checker_msg,omitempty"`
}

type Result struct {
	CompileOK      bool         `json:"compile_ok"`
	CompileMessage string       `json:"compile_message,omitempty"`
	Tests          []TestResult `json:"tests"`
}

type CompleteRequest struct {
	LeaseEpoch int    `json:"lease_epoch"`
	Result     Result `json:"result"`
}

type FailRequest struct {
	LeaseEpoch int    `json:"lease_epoch"`
	Error      string `json:"error"`
	Retryable  bool   `json:"retryable"`
}

type Accepted struct {
	Accepted bool `json:"accepted"`
}

// Decode parses one JSON value and refuses unknown fields and trailing data.
func Decode(data []byte, into any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("decode: trailing data after the JSON value")
	}
	return nil
}

// ---- validation (Stage 4B) ----
//
// The same discipline as judging: the node reports what it saw, the control plane draws the
// conclusions (apps/api/src/modules/validation/rules.ts).

type ValidationJob struct {
	JobID      string `json:"job_id"`
	LeaseEpoch int    `json:"lease_epoch"`
	LeaseTTLS  int    `json:"lease_ttl_s"`
	Kind       string `json:"kind"`
	Task       Task   `json:"task"`
}

type ValidationLeaseResponse struct {
	Job *ValidationJob `json:"job"`
}

type ValidationTest struct {
	TestID  string `json:"test_id"`
	Verdict string `json:"verdict"`
	CPUMS   int    `json:"cpu_ms"`
}

type ValidationRun struct {
	Solution  string           `json:"solution"`
	Repeat    int              `json:"repeat"`
	CompileOK bool             `json:"compile_ok"`
	Tests     []ValidationTest `json:"tests"`
}

type ValidationBundle struct {
	Opens   bool   `json:"opens"`
	Refusal string `json:"refusal,omitempty"`
}

// ValidationMutant is one change to the reference and whether the tests noticed it.
type ValidationMutant struct {
	Operator  string `json:"operator"`
	Line      int    `json:"line"`
	CompileOK bool   `json:"compile_ok"`
	Killed    bool   `json:"killed"`
}

// ValidationAttacker is how far one of the platform's trivial programs got: tests passed (up to its
// first failure) of all tests.
type ValidationAttacker struct {
	Name   string `json:"name"`
	Passed int    `json:"passed"`
	Total  int    `json:"total"`
}

type ValidationResult struct {
	Bundle    ValidationBundle     `json:"bundle"`
	Runs      []ValidationRun      `json:"runs"`
	Mutants   []ValidationMutant   `json:"mutants"`
	Attackers []ValidationAttacker `json:"attackers"`
}

type ValidationComplete struct {
	LeaseEpoch int              `json:"lease_epoch"`
	Result     ValidationResult `json:"result"`
}

// ---- delivery watermarks (Stage 4C) ----

type WatermarkTask struct {
	Bundle Bundle `json:"bundle"`
	Spec   Spec   `json:"spec"`
	// Tag is the 32-bit mark to write, top bit set; the node never learns what it identifies.
	Tag uint32 `json:"tag"`
}

type WatermarkJob struct {
	JobID      string        `json:"job_id"`
	LeaseEpoch int           `json:"lease_epoch"`
	LeaseTTLS  int           `json:"lease_ttl_s"`
	Kind       string        `json:"kind"`
	Task       WatermarkTask `json:"task"`
}

type WatermarkLeaseResponse struct {
	Job *WatermarkJob `json:"job"`
}

type WatermarkUploadRequest struct {
	LeaseEpoch int `json:"lease_epoch"`
	Bytes      int `json:"bytes"`
}

type WatermarkUploadResponse struct {
	UploadID string `json:"upload_id"`
	URL      string `json:"url"`
}

// WatermarkUnchanged reports a bundle with no safe place for a mark: it is delivered as it is.
type WatermarkUnchanged struct {
	Outcome string `json:"outcome"`
}

// WatermarkObservations is the harness run on the original and on the rewritten bundle.
type WatermarkObservations struct {
	Original  ValidationResult `json:"original"`
	Rewritten ValidationResult `json:"rewritten"`
}

// WatermarkRewritten reports an uploaded rewritten bundle. Observations is null (not absent) for tasks the
// harness cannot run.
type WatermarkRewritten struct {
	Outcome      string                 `json:"outcome"`
	UploadID     string                 `json:"upload_id"`
	Answers      bool                   `json:"answers"`
	Solutions    bool                   `json:"solutions"`
	Observations *WatermarkObservations `json:"observations"`
}

type WatermarkComplete struct {
	LeaseEpoch int `json:"lease_epoch"`
	Result     any `json:"result"`
}
