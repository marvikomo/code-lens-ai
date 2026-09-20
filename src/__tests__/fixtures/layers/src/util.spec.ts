import { describe, it, expect } from "vitest";
import { clamp } from "./util";

describe("clamp", () => {
  it("clamps", () => {
    expect(clamp(5, 0, 3)).toBe(3);
  });
});
