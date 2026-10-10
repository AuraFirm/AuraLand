import { FragmentToken } from "../../../components/fragment-token.tsx";

export const metadata = { title: "Join an organization · AuraLand" };

export default function AcceptInvitationPage() {
    return (
        <FragmentToken
            path="/invitations/accept"
            next="/orgs"
            title="Joining the organization"
            working="Checking your invitation…"
            signInHint="Sign in with the email address this invitation was sent to, then open the link from your email again."
        />
    );
}
