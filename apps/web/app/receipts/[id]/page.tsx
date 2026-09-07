import { redirect } from "next/navigation";
import { ReceiptReview } from "@/app/manager/receipt-review";
import { getActorFromCookies } from "@/lib/auth/guards";
export const dynamic = "force-dynamic";
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getActorFromCookies();
  if (!actor) redirect("/login");
  if (actor.role !== "manager" && actor.role !== "admin")
    return (
      <main>
        <h1>Manager access required</h1>
      </main>
    );
  const { id } = await params;
  return <ReceiptReview id={id} actorRole={actor.role} />;
}
