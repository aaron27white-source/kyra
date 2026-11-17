import type { APIRoute } from "astro"
import {
  changelogAnchorId,
  changelogPath,
  getChangelogEntries,
} from "@/lib/changelog"
import { markdownResponse } from "@/lib/markdown-response"
import { absoluteUrl } from "@/lib/seo"

export const GET: APIRoute = async () => {
  const entries = await getChangelogEntries("en")

  const markdown = `# What's new with Lead My Company?

Product updates, integrations, and improvements from the Lead My Company team.

## Updates

${entries
  .map(
    (entry) =>
      `- [${entry.data.title}](${absoluteUrl(changelogPath("en", changelogAnchorId(entry)))}) - ${entry.data.description}`
  )
  .join("\n")}
`

  return markdownResponse({
    markdown,
    canonical: absoluteUrl("/changelog/"),
    title: "Lead My Company Changelog",
    description:
      "Follow Lead My Company product updates, improvements, integrations, and shipped changes for the open-source AI receptionist platform.",
  })
}
