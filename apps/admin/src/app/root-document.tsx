import { isPilotMode } from "@lobbystack/shared";
import { brand } from "@lobbystack/shared/brand";
import { Providers } from "@/app/providers";
import { resourcesForRoute } from "@/lib/i18n-resources";
import type { SupportedLocale } from "@/lib/locale";
import type { LocaleSource } from "@/lib/locale-request";

export const appMetadata = {
  title: brand.name,
  description: brand.tagline,
  icons: { icon: [{ url: "/brand/lmc-logo.svg", type: "image/svg+xml" }] },
};

export function RootDocument({
  children,
  locale,
  localeSource,
  namespaces,
}: {
  children: React.ReactNode;
  locale: SupportedLocale;
  localeSource: LocaleSource;
  namespaces: readonly string[];
}) {
  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <Providers
          pilotMode={isPilotMode(process.env)}
          initialLocale={locale}
          initialLocaleSource={localeSource}
          initialResources={resourcesForRoute(locale, namespaces)}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
