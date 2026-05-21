import { defineConfig } from "vitest/config";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [
    svelte({
      hot: !process.env.VITEST,
      // The default `vitePreprocess()` from svelte.config.js relies on vite's
      // `preprocessCSS`, which is not available in vitest's lightweight Vite
      // env and crashes on every component with a `<style>` block. Disabling
      // style preprocessing keeps TS preprocessing working while letting the
      // svelte compiler handle plain CSS itself.
      preprocess: vitePreprocess({ style: false }),
    }),
  ],
  // Resolve to the browser build of svelte so `mount()` is available during
  // component tests; the default condition picks the SSR entry which throws.
  resolve: {
    conditions: ["browser"],
  },
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
});
