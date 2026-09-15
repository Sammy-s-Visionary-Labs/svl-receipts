import { Suspense } from "react";
import { CaptureReceipt } from "./capture";

export default function NewReceiptPage() {
  return (
    <Suspense fallback={<p role="status">Opening receipt capture…</p>}>
      <CaptureReceipt />
    </Suspense>
  );
}
