import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopbackUrl, modelIsPulled, pickOllamaModel } from "../src/lib/ghost/ollama.ts";

describe("ollama helpers", () => {
  it("prefers gemma3:4b when it is installed", () => {
    assert.equal(pickOllamaModel(["gemma4:latest", "gemma3:4b"]), "gemma3:4b");
  });
  it("falls back to the first installed model", () => {
    assert.equal(pickOllamaModel(["mistral:7b"]), "mistral:7b");
    assert.equal(pickOllamaModel([]), null);
  });
  it("matches untagged names against pulled tags", () => {
    assert.ok(modelIsPulled("gemma4", ["gemma4:latest"]));
    assert.ok(!modelIsPulled("gemma3:1b", ["gemma3:4b"]));
  });
  it("only allows loopback addresses", () => {
    for (const ok of ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"]) assert.ok(isLoopbackUrl(ok), ok);
    for (const bad of ["http://192.168.1.5:11434", "https://example.com", "ftp://localhost", "nonsense", "http://localhost.evil.com"]) assert.ok(!isLoopbackUrl(bad), bad);
  });
});
