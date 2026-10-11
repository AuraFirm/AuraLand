import { decodeId, idSchema } from "@aura/contracts/ids";
import {
    NODE_HEADER,
    NONCE_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
} from "@aura/contracts/judge-protocol";
import { NODE_SIGNATURE_SKEW_MS } from "@aura/contracts/limits";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { findNode, recordNonce } from "./node-queries.ts";
import { verifySignature } from "./signing.ts";

// Authentication for /judge/v1: the request must carry a node id, a fresh timestamp, a single-use
// nonce and an Ed25519 signature over the method, path, timestamp, nonce and body hash. Every failure
// gets the same bare 401, so a caller learns nothing about which nodes exist. The request then runs in
// one transaction as the worker role.

export interface NodeAuthDeps {
    readonly sql: Sql;
    readonly clock: Clock;
}

const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export const nodeAuth =
    (deps: NodeAuthDeps): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
        const denied = () => problemResponse(c, "unauthenticated", "Authentication required");
        const nodeText = c.req.header(NODE_HEADER) ?? "";
        const timestampText = c.req.header(TIMESTAMP_HEADER) ?? "";
        const nonce = c.req.header(NONCE_HEADER) ?? "";
        const signatureText = c.req.header(SIGNATURE_HEADER) ?? "";
        const nodeId = idSchema("nod").safeParse(nodeText);
        const timestampMs = /^\d{10,16}$/.test(timestampText) ? Number(timestampText) : Number.NaN;
        const nowMs = deps.clock.nowUnixMs();
        if (!nodeId.success || !NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signatureText))
            return denied();
        if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > NODE_SIGNATURE_SKEW_MS)
            return denied();
        const body = await c.req.text();
        const target = new URL(c.req.url).pathname + new URL(c.req.url).search;
        // The nonce is spent in its own committed transaction, so a request that later fails (and rolls
        // its work back) still cannot be sent again.
        const verifiedNode = await withRequestContext(deps.sql, WORKER, async (tx) => {
            const node = await findNode(tx, decodeId("nod", nodeId.data));
            if (node === null || node.state === "revoked") return null;
            const signature = Buffer.from(signatureText, "base64url");
            if (
                !verifySignature(
                    node.public_key,
                    { method: c.req.method, target, timestampMs, nonce, body },
                    signature,
                )
            ) {
                return null;
            }
            // Only a verified request may spend a nonce, so strangers cannot fill the table.
            return (await recordNonce(tx, node.id, Buffer.from(nonce), nowMs)) ? node.id : null;
        });
        if (verifiedNode === null) return denied();
        try {
            await withRequestContext(deps.sql, WORKER, async (tx) => {
                c.set("tx", tx);
                c.set("nodeId", verifiedNode);
                await next();
                if (c.res.status >= 400) throw new RollbackRequest();
            });
        } catch (error) {
            if (!(error instanceof RollbackRequest)) throw error;
        }
        return undefined;
    };

class RollbackRequest extends Error {}
