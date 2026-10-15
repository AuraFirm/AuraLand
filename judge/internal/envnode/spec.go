package envnode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Spec is the part of an environment recipe (contracts/environment.ts, spec version 2) the node acts on. It is decoded
// strictly: a field the node does not know is a refusal, so a recipe cannot ask for something this node would silently ignore.
type Spec struct {
	SpecVersion int    `json:"spec_version"`
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	Image       struct {
		Digest string `json:"digest"`
		Ref    string `json:"ref,omitempty"`
	} `json:"image"`
	Setup [][]string `json:"setup"`
	Agent struct {
		Command        []string `json:"command"`
		Workspace      string   `json:"workspace"`
		TimeLimitS     int      `json:"time_limit_s"`
		MemoryLimitMiB int      `json:"memory_limit_mib"`
		DiskLimitMiB   int      `json:"disk_limit_mib"`
		PidsLimit      int      `json:"pids_limit"`
		OutputLimitKiB int      `json:"output_limit_kib"`
	} `json:"agent"`
	Network struct {
		Mode  string `json:"mode"`
		Allow []struct {
			Host string `json:"host"`
			Port int    `json:"port"`
		} `json:"allow"`
	} `json:"network"`
	Verifier struct {
		Command        []string `json:"command"`
		TimeLimitS     int      `json:"time_limit_s"`
		MemoryLimitMiB int      `json:"memory_limit_mib"`
		Canaries       int      `json:"canaries"`
	} `json:"verifier"`
	Integrity struct {
		ProtectedPaths []string `json:"protected_paths"`
		Honeypots      []string `json:"honeypots"`
	} `json:"integrity"`
	Scoring struct {
		Type string `json:"type"`
	} `json:"scoring"`
}

func ParseSpec(raw []byte) (Spec, error) {
	var spec Spec
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&spec); err != nil {
		return spec, fmt.Errorf("spec: %w", err)
	}
	if spec.SpecVersion != 2 {
		return spec, fmt.Errorf("spec: version %d is not supported", spec.SpecVersion)
	}
	// No node can contain a network allowlist (ADR 0034): refuse rather than run without it.
	if spec.Network.Mode != "none" {
		return spec, fmt.Errorf("spec: network mode %q is not supported by this node", spec.Network.Mode)
	}
	if !strings.HasPrefix(spec.Image.Digest, "sha256:") || len(spec.Image.Digest) != 71 {
		return spec, fmt.Errorf("spec: the image is not pinned by a sha256 digest")
	}
	return spec, nil
}

// relative turns an absolute path under the workspace into one relative to it.
func relative(workspace, path string) (string, error) {
	prefix := strings.TrimSuffix(workspace, "/") + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", fmt.Errorf("spec: %q is not under the workspace %q", path, workspace)
	}
	return strings.TrimPrefix(path, prefix), nil
}
