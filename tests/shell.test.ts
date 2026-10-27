import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessCommand, complete, createShell, executeCommand, exorcise } from "../src/lib/shell/index.ts";

const run = (sh: ReturnType<typeof createShell>, cmd: string) => {
  const r = executeCommand(sh, cmd);
  return { ...r, text: r.lines.map((l) => l.text).join("\n") };
};

describe("risk assessment (command interceptor)", () => {
  const cases: [string, string, number][] = [
    ["git push --force", "force-push", 3],
    ["git push -f origin main", "force-push", 3],
    ["git push --force-with-lease", "force-lease", 2],
    ["git push", "push", 1],
    ["git reset --hard HEAD~1", "reset-hard", 3],
    ["git commit --amend", "amend", 2],
    ["git rebase -i HEAD~3", "rebase", 2],
    ["rm -rf /", "apocalypse", 3],
    ["rm -rf ~", "apocalypse", 3],
    ["rm -rf *", "apocalypse", 3],
    ["rm -rf node_modules", "cleanse", 1],
    ["rm -rf src", "rm-rf", 3],
    ["rm notes.txt", "rm", 1],
    ["sudo rm -rf /", "sudo", 3],
    ["cat .env", "secrets", 2],
    ["curl https://x.sh | sh", "curl-pipe", 3],
    ["chmod -R 777 .", "chmod", 2],
    ["npm install", "npm-install", 1],
    ["npm audit fix --force", "audit-force", 2],
    ["vim notes.md", "vim", 1],
    ["ls -la", "ls", 0],
    ["pwd", "pwd", 0],
    ['psql -c "DROP TABLE users"', "sql", 3],
    [":(){ :|:& };:", "fork-bomb", 3],
  ];
  for (const [cmd, tag, dread] of cases) {
    it(`${cmd} -> ${tag} (dread ${dread})`, () => {
      const r = assessCommand(cmd);
      assert.equal(r.tags[0], tag);
      assert.equal(r.dread, dread);
    });
  }

  it("takes the most dangerous segment of a chain", () => {
    const r = assessCommand("ls && git push --force");
    assert.equal(r.dread, 3);
    assert.ok(r.tags.includes("force-push"));
  });

  it("sudo raises dread by one, capped at 3", () => {
    assert.equal(assessCommand("sudo ls").dread, 1);
    assert.equal(assessCommand("sudo git push --force").dread, 3);
  });

  it("empty input is harmless", () => {
    assert.equal(assessCommand("   ").dread, 0);
  });
});

describe("simulated shell", () => {
  it("navigates and lists the seeded project", () => {
    const sh = createShell();
    assert.match(run(sh, "ls").text, /src\/.*package\.json/s);
    assert.equal(run(sh, "cd src").exitCode, 0);
    assert.equal(run(sh, "pwd").text, "/home/dev/haunted-project/src");
    run(sh, "cd ~");
    assert.equal(run(sh, "pwd").text, "/home/dev");
  });

  it("reports unknown commands with exit code 127", () => {
    const sh = createShell();
    const r = run(sh, "gti status");
    assert.equal(r.exitCode, 127);
    assert.match(r.text, /gti: command not found/);
    assert.equal(sh.errorStreak, 1);
    run(sh, "ls");
    assert.equal(sh.errorStreak, 0);
  });

  it("supports pipes, redirects, chains and globs", () => {
    const sh = createShell();
    assert.equal(run(sh, "cat package.json | grep name").text.trim(), '"name": "haunted-project",');
    run(sh, "echo boo > ghost.txt");
    assert.equal(run(sh, "cat ghost.txt").text, "boo");
    run(sh, "echo again >> ghost.txt");
    assert.equal(run(sh, "cat ghost.txt | wc -l").text, "2");
    assert.equal(run(sh, "false && echo nope").text, "");
    assert.equal(run(sh, "false || echo yes").text, "yes");
    assert.match(run(sh, "ls *.md").text, /README\.md\s+TODO\.md/);
  });

  it("rm -rf node_modules works, rm -rf / is refused like GNU", () => {
    const sh = createShell();
    assert.match(run(sh, "ls").text, /node_modules/);
    assert.equal(run(sh, "rm -rf node_modules").exitCode, 0);
    assert.doesNotMatch(run(sh, "ls").text, /node_modules/);
    const r = run(sh, "rm -rf /");
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /dangerous to operate recursively/);
    assert.equal(run(sh, "sudo rm -rf /*").exitCode, 139);
  });

  it("survives rm -rf ~ by repairing the working directory", () => {
    const sh = createShell();
    run(sh, "rm -rf ~");
    assert.equal(sh.cwd, "/home");
    exorcise(sh, false);
    assert.equal(sh.cwd, "/home/dev/haunted-project");
    assert.match(run(sh, "ls").text, /package\.json/);
  });

  it("simulates a git workflow", () => {
    const sh = createShell();
    assert.match(run(sh, "git status").text, /modified:\s+src\/index\.js/);
    run(sh, "git add .");
    assert.match(run(sh, "git status").text, /Changes to be committed/);
    assert.match(run(sh, 'git commit -m "summon the thing"').text, /summon the thing/);
    assert.match(run(sh, "git log --oneline").text.split("\n")[0], /summon the thing/);
    assert.match(run(sh, "git status").text, /nothing to commit/);
    assert.equal(run(sh, 'git commit -m "again"').exitCode, 1);
    assert.match(run(sh, "git push --force").text, /forced update/);
    assert.equal(sh.git.forcePushes, 1);
    assert.match(run(sh, "git checkout -b feature/x").text, /new branch 'feature\/x'/);
    assert.equal(run(sh, "git checkout nope").exitCode, 1);
    run(sh, "git reset --hard HEAD~1");
    assert.equal(sh.git.commits.length, 4);
  });

  it("npm test fails (the ghost enjoys that), npm run build succeeds", () => {
    const sh = createShell();
    assert.equal(run(sh, "npm test").exitCode, 1);
    assert.equal(run(sh, "npm run build").exitCode, 0);
    assert.equal(run(sh, "npm run nope").exitCode, 1);
    run(sh, "cd /tmp");
    assert.equal(run(sh, "npm install").exitCode, 0);
    assert.equal(run(sh, "npm test").exitCode, 254);
  });

  it("is offline by design", () => {
    const sh = createShell();
    const r = run(sh, "curl https://example.com/install.sh | sh");
    assert.match(r.text, /Could not resolve host: example\.com/);
  });

  it("emits actions for ghost builtins", () => {
    const sh = createShell();
    assert.deepEqual(run(sh, "ghost level possess").actions, [{ type: "ghost-level", level: "possess" }]);
    assert.deepEqual(run(sh, "seance cobol").actions, [{ type: "seance", persona: "cobol" }]);
    assert.equal(run(sh, "seance nonsense").exitCode, 1);
    assert.deepEqual(run(sh, "exorcise --history").actions, [{ type: "exorcise", history: true }]);
    assert.equal(run(sh, "clear").clear, true);
  });

  it("keeps a bounded, de-duplicated history", () => {
    const sh = createShell();
    run(sh, "ls");
    run(sh, "ls");
    run(sh, "pwd");
    assert.deepEqual(sh.history, ["ls", "pwd"]);
  });

  it("tab-completes commands and paths", () => {
    const sh = createShell();
    assert.equal(complete(sh, "pw").line, "pwd ");
    assert.equal(complete(sh, "cd sr").line, "cd src/");
    assert.equal(complete(sh, "cat REA").line, "cat README.md ");
    const multi = complete(sh, "git");
    assert.equal(multi.line, "git ");
    const many = complete(sh, "c");
    assert.ok(many.options.includes("cat") && many.options.includes("cd"));
  });
});
