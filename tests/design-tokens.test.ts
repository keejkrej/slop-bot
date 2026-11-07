import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { theme } from "@slopbot/design-tokens";

const files = {
  web: "apps/web/app/globals.css",
  mobile: "apps/mobile/global.css",
  desktop: "apps/desktop/src/mainview/index.css",
};

describe("shared Lyra design tokens", () => {
  it("keeps every web and native semantic color synchronized", async () => {
    for (const file of [files.web, files.mobile]) {
      const css = await readFile(file, "utf8");
      for (const palette of Object.values(theme)) {
        for (const color of Object.values(palette)) expect(css).toContain(color);
      }
    }
  });

  it("keeps the desktop shell on the same core palette", async () => {
    const css = await readFile(files.desktop, "utf8");
    for (const palette of Object.values(theme)) {
      for (const key of ["background", "foreground", "muted", "mutedForeground", "border", "destructive"] as const) {
        expect(css).toContain(palette[key]);
      }
    }
  });
});
