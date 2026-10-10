import { describe, expect, it } from "vitest";

describe("tooling smoke", () => {
  it("runs vitest with the configured environment and alias", () => {
    expect(typeof process.versions.node).toBe("string");
    expect(1 + 1).toBe(2);
  });
});
