import { DeliveriesList } from "../../components/deliveries-list.tsx";
import { page } from "../../lib/styles.ts";

export const metadata = { title: "Deliveries · AuraLand" };

export default function DeliveriesPage() {
    return (
        <main className={page}>
            <h1 className="text-2xl font-semibold">Deliveries</h1>
            <DeliveriesList />
        </main>
    );
}
