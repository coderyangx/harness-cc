import { describe, expect, test } from "vitest";
import webPackage from "../web/package.json";

describe("web package scripts", () => {
  test("start script serves the static export output", () => {
    expect(webPackage.scripts.start).toContain("serve");
    expect(webPackage.scripts.start).toContain("out");
  });
});
