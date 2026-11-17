import { brand } from "@lobbystack/shared/brand"
import { buttonVariants } from "@/components/ui/button"
import { APP_SIGNUP_URL } from "@/lib/app-links"
import { cn } from "@/lib/utils"
import { getCopy, localizePath, type Locale } from "@/i18n"
import { ArrowRight } from "lucide-react"
import type { ReactNode } from "react"

type HeroSectionProps = {
  children?: ReactNode
  locale?: Locale
}

const heroCopy = {
  en: {
    h1Start: "Turn",
    h1Emphasis: "new leads",
    h1End: "into booked jobs.",
    body: brand.tagline,
    pricing: "Built for service businesses. Email first, with your team in control.",
  },
  fr: {
    h1Start: "Lead My Company transforme",
    h1Emphasis: "nouveaux prospects",
    h1End: "en rendez‑vous.",
    body: "Lead My Company aide les entreprises de services à répondre aux prospects par e-mail, à qualifier leurs demandes et à réserver des visites, 24 h/24.",
    pricing:
      "Pour les entreprises de services. Votre équipe garde le contrôle.",
  },
} satisfies Record<Locale, Record<string, string>>

export function HeroSection({ children, locale = "en" }: HeroSectionProps) {
  const copy = getCopy(locale)
  const localCopy = heroCopy[locale]

  return (
    <section
      className="relative grid min-h-[calc(100svh-4rem)] items-center overflow-hidden"
      id="hero"
    >
      <div className="mx-auto w-full max-w-7xl px-6 pt-14 pb-10 md:pt-10 md:pb-20 lg:pt-12 lg:pb-24">
        <div className="grid min-w-0 items-center gap-6 md:gap-12 xl:grid-cols-2 xl:gap-16">
          <div className="max-w-3xl min-w-0 text-left">
            <h1 className="animate-fade-up display-heading">
              {locale === "fr" ? (
                <>
                  {localCopy.h1Start} les{" "}
                  <span className="underline decoration-2 underline-offset-4">
                    {localCopy.h1Emphasis}
                  </span>{" "}
                  {localCopy.h1End}
                </>
              ) : (
                <>
                  {localCopy.h1Start}{" "}
                  <span className="underline decoration-2 underline-offset-4">
                    {localCopy.h1Emphasis}
                  </span>{" "}
                  {localCopy.h1End}
                </>
              )}
            </h1>

            <p className="animate-fade-up body-copy mt-6 max-w-[65ch] stagger-2 md:text-lg">
              {localCopy.body}
            </p>

            <div className="animate-fade-up mt-8 flex flex-col items-stretch gap-3 stagger-3 sm:flex-row sm:items-center">
              <a
                href={APP_SIGNUP_URL}
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "h-11 w-full rounded-full px-6 text-sm sm:w-auto sm:px-8"
                )}
                data-ph-signup-cta
                data-ph-capture-attribute-section="hero"
                data-ph-capture-attribute-action="try_for_free"
                data-ph-capture-attribute-destination={APP_SIGNUP_URL}
              >
                {copy.common.tryFree}
                <ArrowRight className="ml-1 size-4 transition-transform duration-200 ease-(--ease-out) group-hover/button:translate-x-0.5" />
              </a>
              <a
                href={localizePath(locale, "/pricing/")}
                className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 w-full rounded-full px-6 text-sm sm:w-auto")}
              >
                {copy.common.viewPricing}
              </a>
            </div>

            {/* Micro-copy */}
            <p className="animate-fade-up fine-print mt-5 stagger-4">
              {localCopy.pricing}
            </p>
          </div>

          <div className="animate-fade-up mx-auto flex w-full max-w-[22rem] min-w-0 justify-center stagger-5 md:max-w-[30rem] xl:max-w-none xl:justify-end">
            {children}
          </div>
        </div>
      </div>
    </section>
  )
}
