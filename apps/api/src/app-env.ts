import type { AuthMethod } from "@aura/contracts/identity";
import type { Transaction } from "@aura/db/context";
import type { OrgMembership } from "./modules/identity/authorize.ts";

// Who is making the request. Resolved once by the authenticate middleware and read by everything
// after it; handlers never look at cookies themselves.
export type Actor =
    | { readonly kind: "anonymous" }
    | {
          readonly kind: "user";
          readonly userId: string;
          readonly sessionId: string;
          readonly authMethod: AuthMethod;
          readonly privileged: boolean;
          readonly stepUpAtMs: number | null;
          // The organizations this person belongs to, loaded when the request is identified.
          readonly orgs: readonly OrgMembership[];
          readonly platformRole: "none" | "admin";
      }
    // A request authenticated by an organization API key. It acts for that organization only.
    | {
          readonly kind: "api_key";
          readonly keyId: string;
          readonly orgId: string;
          readonly scopes: readonly string[];
      };

export interface AppEnv {
    Variables: {
        requestId: string;
        actor: Actor;
        // The request's database transaction, already acting as the right role (dbContext).
        tx: Transaction;
        // Set by authenticate when the browser sent a session cookie we no longer accept.
        clearSessionCookie: boolean;
    };
}
