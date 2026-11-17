import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";
const root = fileURLToPath(new URL("../../", import.meta.url));
export default mergeConfig(base, {
  resolve: {
    alias: {
      "@lobbystack/providers/crypto/secretBox": `${root}/packages/providers/src/crypto/secretBox.ts`,
      "@lobbystack/providers": `${root}/packages/providers/src/index.ts`,
    },
  },
  test: {
    include: ["src/lib/lmc-form.integration.test.ts"],
    fileParallelism: false,
  },
});
