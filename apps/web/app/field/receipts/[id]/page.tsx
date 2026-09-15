import { ReceiptDetail } from "./receipt-detail";

export default async function DetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReceiptDetail id={id} />;
}
