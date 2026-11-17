# Lead My Company pilot public site

This app builds six static HTML pages: home, contact, privacy, terms, cookie policy and 404. The contact/legal pages deliberately contain `[FILL]` until the LMC operator supplies approved details. All pages remain noindex and robots disallows crawling during the pilot.

Run from the repository root:

```sh
pnpm landing:build
pnpm landing:typecheck
pnpm --filter @lobbystack/landing lint
pnpm --filter @lobbystack/landing test
pnpm --filter @lobbystack/landing pilot:test
pnpm landing:preview --host 127.0.0.1 --port 4321
pnpm --filter @lobbystack/landing pilot:http http://127.0.0.1:4321
```

`build` verifies the **entire** resulting directory before success. The gate requires the six-page inventory and declared local assets, rejects JavaScript/server files/inline scripts or styles/external resources/inherited claims, checks internal links and requires placeholders and exact software/font license notices. Regression tests mutate a disposable copy and prove these failures are detected. HTTP checks require exact artifact bytes for GET, empty HEAD responses and 404 for retired public surfaces.

Deploy **only `apps/landing/dist/`**, separately from admin/worker, as ordinary static files. Do not upload the app source, `functions/`, `public/`, `src/content/`, the repository, environment files or `node_modules`. No runtime, provider key or database connection belongs in this site. The explicit `pilot/src/pages/` and `pilot-public/` directories are the only routed pages and copied public assets. This is the sole build profile; there is no flag to publish the legacy routes. `_headers` and `_redirects` are host configuration files; a host that does not support that format must configure equivalent response headers/redirects itself. Production host enforcement remains part of staging validation.

Legacy articles, marketing helpers, public assets and function sources remain solely to preserve original source/history/tests. They are outside the active route/public-asset inputs and are never included in the verified deployment directory. All original unit tests remain unchanged. The former SEO validator is retained as `seo:validate:legacy`; the pilot validation command checks the current static artifact, which deliberately has no public sitemap, search index, Markdown alternate pages, analytics, voice demo or machine/API discovery claims. Required copyright and license attribution is preserved under `dist/attributions/`; it is not LMC contact or operator legal information.

The font is the bundled local Geist variable font with its SIL OFL 1.1 notice. No asset is fetched by a page from a font CDN. The only external navigation is the explicit link to the LMC app sign-in page. This local cleanup does not claim a hosted deployment or reviewed final legal terms.
