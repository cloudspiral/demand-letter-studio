import { describe, expect, it } from "vitest";
import { sourceFingerprintForSources } from "./db";

describe("source fingerprints", () => {
  it("is stable across source ordering", () => {
    const sources = [
      { id: "b", sha256: "2".repeat(64) },
      { id: "a", sha256: "1".repeat(64) },
    ];
    expect(sourceFingerprintForSources(sources)).toBe(sourceFingerprintForSources([...sources].reverse()));
  });

  it("changes when supplemental evidence is added or its content changes", () => {
    const initial = [{ id: "a", sha256: "1".repeat(64) }];
    const supplemented = [...initial, { id: "b", sha256: "2".repeat(64) }];
    const changed = [{ id: "a", sha256: "3".repeat(64) }];
    expect(sourceFingerprintForSources(supplemented)).not.toBe(sourceFingerprintForSources(initial));
    expect(sourceFingerprintForSources(changed)).not.toBe(sourceFingerprintForSources(initial));
  });
});
