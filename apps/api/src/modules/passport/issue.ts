import type { Signer } from "../../platform/signer.ts";
import { assembleJwt, type CredentialInput, signingInput } from "./vc.ts";

// Signs one credential. The key id and algorithm come from the signer, not from the caller, so a credential cannot
// name a key that did not sign it.
export async function issueCredentialJwt(
    signer: Signer,
    input: Omit<CredentialInput, "keyId" | "environment">,
): Promise<string> {
    const full: CredentialInput = {
        ...input,
        keyId: signer.keyId,
        environment: signer.environment,
    };
    const text = signingInput(full);
    return assembleJwt(text, await signer.sign(new TextEncoder().encode(text)));
}
