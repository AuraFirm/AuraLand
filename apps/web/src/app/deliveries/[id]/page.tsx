import { DeliveryDetail } from "../../../components/delivery-detail.tsx";
import { page } from "../../../lib/styles.ts";

export const metadata = { title: "Delivery · AuraLand" };

export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main className={page}>
            <DeliveryDetail deliveryId={id} />
        </main>
    );
}
