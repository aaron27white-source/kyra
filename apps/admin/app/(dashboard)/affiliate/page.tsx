import { notFound } from "next/navigation";

import { LiveAffiliateSurface } from "@/components/live-affiliate-surface";
import { affiliateProgramEnabled } from "@/lib/affiliate-program";

export default function AffiliatePage() {
  if (!affiliateProgramEnabled()) notFound();
  return <LiveAffiliateSurface />;
}
