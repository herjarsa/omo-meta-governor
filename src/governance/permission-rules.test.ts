import { describe, expect, it } from "bun:test";
import {
  evaluateBashPolicy,
  evaluateEditPolicy,
  evaluateWebfetchPolicy,
} from "./permission-rules";

describe("evaluateBashPolicy", () => {
  const empty = { bashDenyPatterns: [], bashAskPatterns: [] };

  it("returns null when no patterns match (caller treats as allow)", () => {
    expect(evaluateBashPolicy("ls -la", empty)).toBeNull();
  });

  it("returns null when patterns are undefined", () => {
    expect(evaluateBashPolicy("rm -rf /tmp/foo", {})).toBeNull();
  });

  it("denies commands matching deny pattern", () => {
    const policy = { bashDenyPatterns: ["rm\\s+-rf\\s+/"] };
    const result = evaluateBashPolicy("rm -rf /tmp/foo", policy);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("deny");
    expect(result!.reason).toContain("deny");
  });

  it("deny beats ask when both patterns match", () => {
    const policy = {
      bashDenyPatterns: ["dangerous"],
      bashAskPatterns: ["dangerous"],
    };
    const result = evaluateBashPolicy("run dangerous command", policy);
    expect(result!.decision).toBe("deny");
  });

  it("asks for confirmation when only ask pattern matches", () => {
    const policy = { bashAskPatterns: ["git\\s+push"] };
    const result = evaluateBashPolicy("git push origin main", policy);
    expect(result!.decision).toBe("ask");
  });

  it("matches dangerous pattern in middle of command", () => {
    const policy = { bashDenyPatterns: ["\\bsudo\\b"] };
    const result = evaluateBashPolicy("echo hi && sudo rm file", policy);
    expect(result!.decision).toBe("deny");
  });

  it("skips invalid regex without crashing", () => {
    const policy = { bashDenyPatterns: ["[invalid("] };
    const result = evaluateBashPolicy("ls -la", policy);
    expect(result).toBeNull();
  });
});

describe("evaluateEditPolicy", () => {
  it("returns null when no patterns match", () => {
    expect(
      evaluateEditPolicy("/home/user/project/src/file.ts", { editDenyPaths: [] }),
    ).toBeNull();
  });

  it("denies paths matching deny glob", () => {
    const policy = { editDenyPaths: ["**/.env", "**/secrets/**"] };
    expect(evaluateEditPolicy(".env", policy)!.decision).toBe("deny");
    expect(evaluateEditPolicy("secrets/api.key", policy)!.decision).toBe("deny");
  });

  it("asks for confirmation on ask patterns", () => {
    const policy = { editAskPaths: ["**/package.json"] };
    expect(evaluateEditPolicy("package.json", policy)!.decision).toBe("ask");
  });

  it("allows paths that match no patterns", () => {
    const policy = { editDenyPaths: ["**/.env"], editAskPaths: ["**/config/**"] };
    expect(evaluateEditPolicy("src/index.ts", policy)).toBeNull();
  });
});

describe("evaluateWebfetchPolicy", () => {
  it("returns null when no patterns", () => {
    expect(evaluateWebfetchPolicy("https://example.com/page", {})).toBeNull();
  });

  it("denies exact host match", () => {
    const policy = { webfetchDenyHosts: ["evil.com"] };
    expect(evaluateWebfetchPolicy("https://evil.com/page", policy)!.decision).toBe("deny");
  });

  it("denies subdomain match", () => {
    const policy = { webfetchDenyHosts: ["evil.com"] };
    expect(evaluateWebfetchPolicy("https://api.evil.com/v1", policy)!.decision).toBe("deny");
  });

  it("allows non-matching host", () => {
    const policy = { webfetchDenyHosts: ["evil.com"] };
    expect(evaluateWebfetchPolicy("https://safe.com/page", policy)).toBeNull();
  });

  it("returns null for invalid URL", () => {
    const policy = { webfetchDenyHosts: ["evil.com"] };
    expect(evaluateWebfetchPolicy("not-a-url", policy)).toBeNull();
  });
});