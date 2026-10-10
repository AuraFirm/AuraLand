import { FragmentToken } from "../../../components/fragment-token.tsx";

export const metadata = { title: "Join an organization · AuraLand" };

export default function AcceptInvitationPage() {
    return (
        <FragmentToken
            path="/invitations/accept"
            next="/orgs"
            title="Joining the organization"
            working="Checking your invitation…"
            resume={{ returnTo: "/invitations/accept" }}
        />
    );
}
