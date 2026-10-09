import type { AuthMethod } from "@aura/contracts/identity";
import type { Transaction } from "@aura/db/context";

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
