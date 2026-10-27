import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "@xterm/xterm";
import { TerminalSession } from "../src/lib/term/session.ts";
import type { SessionSnapshot } from "../src/lib/term/session.ts";

/** Just enough of xterm's Terminal for the session: write, onData, cols, focus. */
class FakeTerm {
  cols = 80;
  out = "";
  private handlers: ((d: string) => void)[] = [];
  write(s: string) {
    this.out += s;
  }
  onData(h: (d: string) => void) {
    this.handlers.push(h);
    return { dispose: () => (this.handlers = this.handlers.filter((x) => x !== h)) };
  }
  focus() {}
  send(d: string) {
    for (const h of [...this.handlers]) h(d);
  }
  type(text: string) {
    for (const ch of text) this.send(ch === "\n" ? "\r" : ch);
  }
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(level: "whisper" | "haunt" | "possess" = "possess") {
  const term = new FakeTerm();
  let snap: SessionSnapshot | null = null;
  const session = new TerminalSession({
    term: term as unknown as Terminal,
    getBackend: () => null,
    onChange: (s) => (snap = s),
    reducedMotion: true,
    initialLevel: level,
  });
  await session.start();
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      if (snap && !(snap as SessionSnapshot).busy) return;
      await sleep(5);
    }
    throw new Error("session stayed busy");
  };
  return { term, session, idle, snap: () => snap as SessionSnapshot };
}

describe("terminal session", () => {
  it("boots to a prompt and runs a command with a whisper", async () => {
    const { term, session, idle } = await boot();
    assert.match(plain(term.out), /Echoes of the Terminal/);
    assert.match(plain(term.out), /dev@crypt:~\/haunted-project \(main\)\$ $/);
    term.type("ls\n");
    await idle();
    const text = plain(term.out);
    assert.match(text, /node_modules\//);
    assert.match(text, /\n~ \S/, "the ghost should whisper after ls at possess level");
    session.dispose();
  });

  it("keeps keystrokes typed while the ghost is busy (type-ahead)", async () => {
    const { term, session, idle } = await boot();
    term.type("ls\n");
    term.type("pwd\n"); // arrives while the first command is still running
    await sleep(20);
    await idle();
    await sleep(30);
    await idle();
    const text = plain(term.out);
    assert.match(text, /\$ ls\n/);
    assert.match(text, /\$ pwd\n/);
    assert.match(text, /\/home\/dev\/haunted-project\n/);
    session.dispose();
  });

  it("raises presence on dangerous commands and calms on safe ones", async () => {
    const { term, session, idle, snap } = await boot();
    const base = snap().presence;
    term.type("git push --force\n");
    await idle();
    const raised = snap().presence;
    assert.ok(raised >= base + 30, `presence ${base} -> ${raised}`);
    term.type("pwd\n");
    await idle();
    assert.ok(snap().presence < raised);
    session.dispose();
  });

  it("honours ghost off, seance and exorcise actions", async () => {
    const { term, session, idle, snap } = await boot();
    term.type("seance cobol\n");
    await idle();
    assert.equal(snap().persona, "cobol");
    assert.match(plain(term.out), /IDENTIFICATION DIVISION/);
    term.type("ghost off\n");
    await idle();
    assert.equal(snap().ghostOn, false);
    const before = plain(term.out).length;
    term.type("ls\n");
    await idle();
    assert.doesNotMatch(plain(term.out).slice(before), /\n~ /, "a silenced ghost stays silent");
    term.type("exorcise\n");
    await idle();
    assert.equal(snap().persona, null);
    assert.equal(snap().presence, 0);
    session.dispose();
  });

  it("edits the line: backspace, history and tab completion", async () => {
    const { term, session, idle } = await boot("whisper");
    term.type("cat REA");
    term.send("\t");
    assert.match(plain(term.out), /cat README\.md $/);
    for (let i = 0; i < 3; i++) term.send("\x7f"); // one key per press, like xterm
    term.type("md\n");
    await idle();
    term.send("\x1b[A");
    assert.match(plain(term.out), /\$ cat README\.md$/);
    session.dispose();
  });
});
