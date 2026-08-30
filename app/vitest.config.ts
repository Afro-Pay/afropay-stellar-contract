import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["**/*.test.{js,ts,jsx,tsx}", "**/*.spec.{js,ts,jsx,tsx}"],
  },
});
