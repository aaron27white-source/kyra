import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "astro/config"

// Only this explicit static public directory is copied. Legacy public/content
// fixtures/routes are retained for unchanged tests. Only pilot/src/pages is
// routed; legacy src/pages and functions are never deployment inputs.
export default defineConfig({
  output: "static",
  srcDir: "./pilot/src",
  site: "https://leadmycompany.com",
  publicDir: "./pilot-public",
  trailingSlash: "always",
  devToolbar: { enabled: false },
  build: { inlineStylesheets: "never" },
  vite: { plugins: [tailwindcss()] },
})
