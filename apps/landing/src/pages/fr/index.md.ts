import type { APIRoute } from "astro"
import { markdownResponse } from "@/lib/markdown-response"
import { absoluteUrl } from "@/lib/seo"

const markdown = `---
title: Lead My Company | Réceptionniste IA open source
description: Lead My Company est le réceptionniste IA open source qui répond aux appels, qualifie les demandes, planifie des rendez‑vous et transfère les urgences 24/7.
url: ${absoluteUrl("/fr/")}
---

# Lead My Company

Lead My Company est un réceptionniste IA open source pour les petites entreprises qui dépendent des appels, des rendez‑vous et d’une réponse rapide.

## Ce que fait Lead My Company

- Répond aux appels entrants 24/7.
- Utilise vos connaissances d’entreprise pour répondre aux questions courantes.
- Qualifie les prospects, prend des rendez‑vous et transfère les demandes urgentes.
- Donne aux petites entreprises une pile de réception inspectable et open source.

## Ressources publiques

- Fonctionnalités : ${absoluteUrl("/fr/features/")}
- Tarifs : ${absoluteUrl("/fr/pricing/")}
- Solutions : ${absoluteUrl("/fr/solutions/")}
- Calculateur : ${absoluteUrl("/fr/missed-call-revenue-calculator/")}
- Blog : ${absoluteUrl("/fr/blog/")}
- GitHub : https://github.com/lobbystack/lobbystack
`

export const GET: APIRoute = () =>
  markdownResponse({
    markdown,
    canonical: absoluteUrl("/fr/"),
    title: "Lead My Company | Réceptionniste IA open source",
    description:
      "Lead My Company est le réceptionniste IA open source qui répond aux appels, qualifie les demandes, planifie des rendez‑vous et transfère les urgences 24/7.",
  })
