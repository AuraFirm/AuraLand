// Package sign implements request signing for the judge-node protocol: Ed25519 over a canonical text
// that binds the method, the exact path and query, a timestamp, a single-use nonce and the SHA-256 of
// the body (apps/api/src/modules/judge/signing.ts is the verifying side).
package sign

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"
)

const Domain = "AURA-NODE-V1"

// Canonical returns the text that is signed.
func Canonical(method, target string, timestampMS int64, nonce string, body []byte) string {
	sum := sha256.Sum256(body)
	return strings.Join([]string{
		Domain,
		strings.ToUpper(method),
		target,
		strconv.FormatInt(timestampMS, 10),
		nonce,
		hex.EncodeToString(sum[:]),
	}, "\n")
}

// Sign returns the base64url signature of the canonical text.
func Sign(key ed25519.PrivateKey, method, target string, timestampMS int64, nonce string, body []byte) string {
	signature := ed25519.Sign(key, []byte(Canonical(method, target, timestampMS, nonce, body)))
	return base64.RawURLEncoding.EncodeToString(signature)
}

// Encode returns bytes as unpadded base64url, the encoding of keys, nonces and signatures.
func Encode(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

// TraceDomain separates the signature of a run's trace from every request signature: the same key signs both, and a
// signature made for one must not verify as the other.
const TraceDomain = "AURA-TRACE-V1"

func traceMessage(body []byte) []byte {
	sum := sha256.Sum256(body)
	return []byte(TraceDomain + "\n" + hex.EncodeToString(sum[:]))
}

// SignTrace signs the SHA-256 of a trace's canonical bytes, with a domain that no request signature uses.
func SignTrace(key ed25519.PrivateKey, body []byte) string {
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, traceMessage(body)))
}

// VerifyTrace reports whether signature is this key's signature of exactly these trace bytes.
func VerifyTrace(key ed25519.PublicKey, body []byte, signature string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(signature)
	return err == nil && len(raw) == ed25519.SignatureSize && ed25519.Verify(key, traceMessage(body), raw)
}
