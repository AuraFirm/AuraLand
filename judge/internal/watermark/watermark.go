// Package watermark does the node's part of delivery watermarks (Stage 4C, ADR 0030): rewrite the bundle
// with the delivery's tag inside a box, run the validation harness on the original and on the rewrite so
// the control plane can compare every verdict, and upload the rewrite. The node decides nothing: whether
// the rewrite ships is the control plane's call.
package watermark

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/AuraFirm/AuraLand/judge/internal/bundles"
	"github.com/AuraFirm/AuraLand/judge/internal/validate"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

type Runner struct {
	Rewriter *bundles.Rewriter
	// Fetch downloads the original bundle of the job; it is not trusted, and Run checks it.
	Fetch func(ctx context.Context, jobID string, bundle wire.Bundle) ([]byte, error)
	// Upload stores the rewritten bundle and returns the id the control plane needs to find it.
	Upload func(ctx context.Context, job wire.WatermarkJob, data []byte) (string, error)
	// Harness builds the validation runner for one bundle's bytes (the original, then the rewrite). A
	// separate runner per bundle keeps each opened from the bytes it is about.
	Harness func(packed []byte) *validate.Runner
}

// Run returns the result to report: WatermarkUnchanged, or WatermarkRewritten after the upload.
func (r *Runner) Run(ctx context.Context, job wire.WatermarkJob) (any, error) {
	packed, err := r.Fetch(ctx, job.JobID, job.Task.Bundle)
	if err != nil {
		return nil, fmt.Errorf("download bundle: %w", err)
	}
	if err := bundles.CheckPacked(packed, job.Task.Bundle); err != nil {
		return nil, err
	}
	rewritten, marks, err := r.Rewriter.Rewrite(ctx, packed, job.Task.Tag)
	if err != nil {
		// A released bundle the validator now refuses is not this node's doing, but it must not ship.
		return nil, fmt.Errorf("rewrite: %w", err)
	}
	if !marks.Answers && !marks.Solutions {
		return wire.WatermarkUnchanged{Outcome: "unchanged"}, nil
	}
	observations, err := r.observe(ctx, job, packed, rewritten)
	if err != nil {
		return nil, err
	}
	uploadID, err := r.Upload(ctx, job, rewritten)
	if err != nil {
		return nil, fmt.Errorf("upload: %w", err)
	}
	return wire.WatermarkRewritten{
		Outcome: "rewritten", UploadID: uploadID, Answers: marks.Answers, Solutions: marks.Solutions, Observations: observations,
	}, nil
}

// observe runs the harness on both bundles. Tasks the harness cannot run (custom checkers, interactive)
// give nil, which the control plane accepts only where the rewrite touched a solution's comment alone.
func (r *Runner) observe(ctx context.Context, job wire.WatermarkJob, original, rewritten []byte) (*wire.WatermarkObservations, error) {
	if job.Task.Spec.Checker.Type == "custom" || job.Task.Spec.Interactive {
		return nil, nil
	}
	before, err := r.harness(ctx, job, original)
	if err != nil {
		return nil, fmt.Errorf("harness on the original: %w", err)
	}
	after, err := r.harness(ctx, job, rewritten)
	if err != nil {
		return nil, fmt.Errorf("harness on the rewrite: %w", err)
	}
	return &wire.WatermarkObservations{Original: before, Rewritten: after}, nil
}

func (r *Runner) harness(ctx context.Context, job wire.WatermarkJob, packed []byte) (wire.ValidationResult, error) {
	digest := sha256.Sum256(packed)
	validation := wire.ValidationJob{
		JobID: job.JobID, LeaseEpoch: job.LeaseEpoch, LeaseTTLS: job.LeaseTTLS, Kind: "task.validate",
		Task: wire.Task{Bundle: wire.Bundle{SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(packed))}, Spec: job.Task.Spec},
	}
	result, err := r.Harness(packed).Run(ctx, validation)
	if err != nil {
		return wire.ValidationResult{}, err
	}
	if !result.Bundle.Opens {
		return wire.ValidationResult{}, errors.New("the bundle does not open: " + result.Bundle.Refusal)
	}
	return result, nil
}
