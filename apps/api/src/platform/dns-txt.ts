import { Resolver } from "node:dns/promises";

// Reading TXT records, behind a port so a test can play DNS. Used to check that an organization controls a domain it claimed for
// single sign-on. The name asked about is built by our code from a validated domain, and the answer is only compared with a token.

export interface TxtResolver {
    resolveTxt(name: string): Promise<string[]>;
}

const TIMEOUT_MS = 3_000;

export function createSystemTxtResolver(): TxtResolver {
    return {
        async resolveTxt(name) {
            const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
            try {
                // A TXT record may be split into several strings; DNS clients join them.
                return (await resolver.resolveTxt(name)).map((parts) => parts.join(""));
            } catch {
                return []; // a name that does not exist or cannot be asked about proves nothing
            }
        },
    };
}
