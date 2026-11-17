import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { SuperAdminMfaSetup } from "@/components/superadmin-mfa";
import { requireSuperAdminEnrollmentSession, SuperAdminAccessError } from "@/lib/superadmin";

export default async function SuperAdminMfaSetupPage() {
  try {
    await requireSuperAdminEnrollmentSession(new Headers(await headers()));
  } catch (error) {
    if (error instanceof SuperAdminAccessError && error.status === 401) redirect("/en/login?returnTo=/internal/mfa/setup");
    notFound();
  }
  return <SuperAdminMfaSetup />;
}
