import { describe, expect, it } from "vitest";
import { resolveJoinUrl } from "../join-url.js";

const origin = "http://localhost:5173";

describe("resolveJoinUrl", () => {
  it("uses a full pasted URL as-is", () => {
    const url = resolveJoinUrl("http://localhost:5173/mcp/cadcca21-1064-4ad8-919e-b4cfeff8efdc", origin);
    expect(url?.href).toBe("http://localhost:5173/mcp/cadcca21-1064-4ad8-919e-b4cfeff8efdc");
  });

  it("resolves a bare token against the page's own origin", () => {
    const url = resolveJoinUrl("cadcca21-1064-4ad8-919e-b4cfeff8efdc", origin);
    expect(url?.href).toBe("http://localhost:5173/mcp/cadcca21-1064-4ad8-919e-b4cfeff8efdc");
  });

  it("resolves a bare token against a different origin (e.g. an SSH-forwarded port)", () => {
    const url = resolveJoinUrl("cadcca21-1064-4ad8-919e-b4cfeff8efdc", "http://localhost:9999");
    expect(url?.href).toBe("http://localhost:9999/mcp/cadcca21-1064-4ad8-919e-b4cfeff8efdc");
  });

  it("returns undefined rather than throwing if even the fallback resolution fails", () => {
    // A malformed origin is the one way both the direct-URL parse and the
    // token-as-path fallback can fail — this is the caller's actual origin
    // (window.location.origin) in production, so it shouldn't realistically
    // happen, but the function must not throw either way.
    expect(resolveJoinUrl("some-token", "not a valid origin")).toBeUndefined();
  });
});
