import { WEBHOOK_EVENTS } from "@aura/contracts/api/webhooks";
import { ERROR_CODES } from "@aura/contracts/errors";
import { page } from "../../lib/styles.ts";

export const metadata = { title: "Developers · AuraLand" };

const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from "node:crypto";

// header: the X-Aura-Signature value, body: the raw request text, secret: your endpoint's signing secret
export function verify(header, body, secret, nowMs = Date.now()) {
    const parts = header.split(",").map((part) => part.split("="));
    const t = Number(parts.find(([name]) => name === "t")?.[1]);
    if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > 300) return false;
    const expected = createHmac("sha256", secret).update(\`\${t}.\${body}\`).digest();
    return parts
        .filter(([name]) => name === "v1")
        .some(([, hex]) => hex.length === 64 && timingSafeEqual(expected, Buffer.from(hex, "hex")));
}`;

// What a developer needs and what is not offered yet, in plain text kept in the code so a change to a claim is a reviewed change.
export default function DevelopersPage() {
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">Developers</h1>
            <Section id="webhooks" title="Webhooks">
                <p>
                    An owner or administrator adds an https address in the organization's admin
                    console. Events: {WEBHOOK_EVENTS.join(", ")}. Each delivery is a POST with the
                    headers <code>X-Aura-Event</code>, <code>X-Aura-Delivery</code> and{" "}
                    <code>X-Aura-Signature: t=&lt;seconds&gt;,v1=&lt;hex&gt;</code>. During a secret
                    rotation there are two <code>v1</code> values; accept either. Reject a timestamp
                    more than five minutes from your clock. Failed deliveries are retried for 24
                    hours with growing delays, then given up on.
                </p>
                {/* Wrapped, not scrolled: a scrolling region would need to be reachable by keyboard. */}
                <pre className="whitespace-pre-wrap break-words rounded-[var(--radius-m)] border border-line p-3 text-sm">
                    {VERIFY_SNIPPET}
                </pre>
                <p>
                    Addresses must be https on port 443 or 8443 and name a public host. Redirects
                    are not followed.
                </p>
            </Section>
            <Section id="scim" title="Provisioning (SCIM 2.0)">
                <p>
                    Enterprise organizations create a bearer token in the admin console and point
                    their identity provider at <code>/api/scim/v2</code>. Supported:{" "}
                    <code>Users</code> create, read, list (filter <code>userName eq "address"</code>{" "}
                    only), replace or patch <code>active</code>, and delete. Only addresses in a
                    domain the organization has verified can be provisioned. Groups are not
                    supported.
                </p>
            </Section>
            <Section id="sso" title="Single sign-on">
                <p>
                    OpenID Connect with the authorization-code flow and PKCE. Register{" "}
                    <code>/api/v1/auth/sso/callback</code> as the redirect address with your
                    provider. SAML is not supported yet.
                </p>
            </Section>
            <Section id="errors" title="Errors">
                <p>
                    Errors are RFC 9457 problem documents. Switch on <code>code</code>, one of:{" "}
                    {ERROR_CODES.join(", ")}.
                </p>
            </Section>
            <Section id="keys" title="API keys">
                <p>
                    Keys can be created in the admin console. Today a key identifies itself and its
                    organization (<code>GET /api/v1/key</code>); other routes are not yet reachable
                    with a key, so there is no SDK. This page will change in the pull request that
                    changes that.
                </p>
            </Section>
        </main>
    );
}

function Section({
    id,
    title,
    children,
}: {
    id: string;
    title: string;
    children: React.ReactNode;
}) {
    return (
        <section aria-labelledby={id} className="flex flex-col gap-2">
            <h2 id={id} className="text-lg font-semibold">
                {title}
            </h2>
            {children}
        </section>
    );
}
