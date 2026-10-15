// The single sign-on module's surface for other modules (the identity module signs people in with it).
export {
    createPublicOidcTransport,
    type Discovery,
    type IdTokenResult,
    type OidcTransport,
    verifyIdToken,
} from "./oidc.ts";
