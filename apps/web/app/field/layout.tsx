import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getActorFromCookies } from "@/lib/auth/guards";
import { FieldShell } from "./shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "SVL Receipts · Field",
  description: "Capture receipts, send them to the office, and follow their progress.",
  manifest: "/field/manifest.webmanifest",
  appleWebApp: { capable: true, title: "SVL Receipts", statusBarStyle: "default" },
  icons: { apple: "/field/icon-180.png", icon: "/field/icon-192.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f7f9f5",
};

export default async function FieldLayout({ children }: { children: ReactNode }) {
  const actor = await getActorFromCookies();
  if (!actor) redirect("/worker-login?next=/field");
  return <FieldShell actor={actor}>{children}</FieldShell>;
}
