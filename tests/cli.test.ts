import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs, redact, shellQuote } from "../cli/haunt.ts";

const CLI = join(import.meta.dirname, "..", "cli", "haunt.ts");

function haunt(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const state = mkdtempSync(join(tmpdir(), "haunt-state-"));
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, XDG_STATE_HOME: state, ...env } }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      resolve({ code: err ? (typeof code === "number" ? code : 1) : 0, stdout, stderr });
    });
  });
}

describe("haunt CLI helpers", () => {
  it("parses options and leaves the command alone", () => {
    const o = parseArgs(["--scripted", "--level", "possess", "git", "push", "--force"], {});
    assert.equal(o.scripted, true);
    assert.equal(o.level, "possess");
    assert.deepEqual(o.rest, ["git", "push", "--force"]);
  });
  it("rejects unknown options and spirits", () => {
    assert.throws(() => parseArgs(["--nope"], {}));
    assert.throws(() => parseArgs(["--seance", "nobody", "ls"], {}));
  });
  it("redacts credentials", () => {
    assert.equal(redact("curl -H 'Authorization: Bearer abc.def' x"), "curl -H 'Authorization: Bearer [redacted]' x");
    assert.equal(redact("deploy --token abc123"), "deploy --token [redacted]");
    assert.equal(redact("PASSWORD=hunter2 ./run"), "PASSWORD=[redacted] ./run");
    assert.equal(redact("git clone https://me:secret@host/r.git"), "git clone https://me:[redacted]@host/r.git");
  });
  it("quotes multi-argument commands but keeps a single string intact", () => {
    assert.equal(shellQuote(["echo hi | wc"]), "echo hi | wc");
    assert.equal(shellQuote(["echo", "a b", "it's"]), "echo 'a b' 'it'\\''s'");
  });
});

describe("haunt CLI end to end", () => {
  it("runs the real command, keeps its exit code, and the ghost comments", async () => {
    const r = await haunt(["--scripted", "--level", "possess", "--", "sh", "-c", "exit 3"]);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /^~ \S/m);
  });

  it("prints shell hooks", async () => {
    assert.match((await haunt(["init", "bash"])).stdout, /PROMPT_COMMAND/);
    assert.match((await haunt(["init", "zsh"])).stdout, /add-zsh-hook precmd/);
  });

  it("refuses an Ollama that is not on this machine", async () => {
    const r = await haunt(["--url", "http://example.com:11434", "whisper", "1", "rm -rf src"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /only talks to Ollama on this machine/);
  });

  it("streams from a local Ollama and never sends secrets", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/api/tags") return void res.end(JSON.stringify({ models: [{ name: "llama3.2:3b" }] }));
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push(body);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { content: "The archive trembles, " }, done: false }) + "\n");
        res.write(JSON.stringify({ message: { content: "mortal. Tread softly." }, done: false }) + "\n");
        res.end(JSON.stringify({ done: true }) + "\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await haunt(["whisper", "0", "git push --force --token=hunter2"], { HAUNT_OLLAMA_URL: `http://127.0.0.1:${port}` });
      assert.match(r.stdout, /The archive trembles, mortal\. Tread softly\./);
      assert.ok(seen.length >= 1);
      assert.ok(seen.every((b) => !b.includes("hunter2")), "secret must be redacted before it reaches the model");
      assert.ok(seen.some((b) => b.includes("[redacted]")));
    } finally {
      server.close();
    }
  });
});
