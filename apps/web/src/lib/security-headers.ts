// Headers that do not vary per request. The per-request Content-Security-Policy is built in
// proxy.ts. Camera and microphone are denied everywhere for now; the exam pages that need them
// will opt in explicitly in the stage that adds webcam proctoring.

export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-site" },
    { key: "X-Frame-Options", value: "DENY" },
];
