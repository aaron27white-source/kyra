import type { APIRoute } from "astro"
import { affiliateProgramMarkdown } from "@/lib/agent-discovery"
import { markdownResponse } from "@/lib/markdown-response"
import { absoluteUrl } from "@/lib/seo"

export const GET: APIRoute = () =>
  markdownResponse({
    markdown: affiliateProgramMarkdown("en"),
    canonical: absoluteUrl("/affiliate-program/"),
    title: "Lead My Company Affiliate Program | Earn 20% Commission",
    description:
      "Refer businesses to hosted Lead My Company plans and earn 20% of their payments for 12 months. Referrals save 5% at signup. PayPal payouts monthly.",
  })
