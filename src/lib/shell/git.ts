import type { Cmd, CmdOut } from "./cmd-types.ts";
import { fail, ok } from "./cmd-types.ts";
import type { Commit, ShellState } from "./types.ts";
import { fakeHash, getNode, normalizePath, removeNode } from "./vfs.ts";

const head = (sh: ShellState): Commit => sh.git.commits[sh.git.commits.length - 1];

function status(sh: ShellState): CmdOut {
  const g = sh.git;
  const out: string[] = [`On branch ${g.branch}`];
  if (g.branch === "main") out.push("Your branch is up to date with 'origin/main'.");
  if (!g.staged.length && !g.modified.length && !g.untracked.length) {
    out.push("", "nothing to commit, working tree clean");
    return { out, code: 0 };
  }
  if (g.staged.length) {
    out.push("", "Changes to be committed:", '  (use "git restore --staged <file>..." to unstage)');
    for (const f of g.staged) out.push(`\tmodified:   ${f}`);
  }
  if (g.modified.length) {
    out.push("", "Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)');
    for (const f of g.modified) out.push(`\tmodified:   ${f}`);
  }
  if (g.untracked.length) {
    out.push("", "Untracked files:", '  (use "git add <file>..." to include in what will be committed)');
    for (const f of g.untracked) out.push(`\t${f}`);
  }
  if (!g.staged.length) {
    out.push("", g.modified.length ? 'no changes added to commit (use "git add" and/or "git commit -a")' : 'nothing added to commit but untracked files present (use "git add" to track)');
  }
  return { out, code: 0 };
}

function pushOut(sh: ShellState, forced: boolean): CmdOut {
  const g = sh.git;
  const newer = head(sh).hash;
  const older = fakeHash(`remote-${g.commits.length - 1}-${g.forcePushes}`);
  if (forced) g.forcePushes++;
  const out = [
    "Enumerating objects: 5, done.",
    "Counting objects: 100% (5/5), done.",
    "Writing objects: 100% (3/3), 312 bytes | 312.00 KiB/s, done.",
    "Total 3 (delta 1), reused 0 (delta 0), pack-reused 0",
    "To github.com:dev/haunted-project.git",
    forced
      ? ` + ${older}...${newer} ${g.branch} -> ${g.branch} (forced update)`
      : `   ${older}..${newer}  ${g.branch} -> ${g.branch}`,
  ];
  return { out, code: 0 };
}

export const git: Cmd = (ctx, args) => {
  const sh = ctx.sh;
  const g = sh.git;
  const sub = args[0];
  const rest = args.slice(1);
  const hasFlag = (...names: string[]) => rest.some((a) => names.includes(a));

  if (!sub || sub === "--version" || sub === "version") return ok("git version 2.47.0");
  if (sub === "--help" || sub === "help") {
    return ok(
      "usage: git <command> [<args>]",
      "",
      "Simulated here: status add commit log diff branch checkout switch push pull fetch",
      "                reset stash rebase merge clean restore remote show tag init",
    );
  }

  switch (sub) {
    case "status":
      return status(sh);

    case "add": {
      const specs = rest.filter((a) => !a.startsWith("-"));
      const all = hasFlag("-A", "--all", "-u") || specs.includes(".");
      if (!all && specs.length === 0) return ok("Nothing specified, nothing added.");
      if (all) {
        g.staged = [...new Set([...g.staged, ...g.modified, ...g.untracked])];
        g.modified = [];
        g.untracked = [];
        return { out: [], code: 0 };
      }
      for (const spec of specs) {
        const norm = spec.replace(/^\.\//, "");
        const inList = (l: string[]) => l.some((f) => f === norm || f.startsWith(norm + "/"));
        if (inList(g.modified) || inList(g.untracked)) {
          const move = (l: string[]) => l.filter((f) => f === norm || f.startsWith(norm + "/"));
          g.staged = [...new Set([...g.staged, ...move(g.modified), ...move(g.untracked)])];
          g.modified = g.modified.filter((f) => !(f === norm || f.startsWith(norm + "/")));
          g.untracked = g.untracked.filter((f) => !(f === norm || f.startsWith(norm + "/")));
        } else if (!getNode(sh.fs, normalizePath(sh.cwd, spec, sh.home))) {
          return fail(`fatal: pathspec '${spec}' did not match any files`, 128);
        }
      }
      return { out: [], code: 0 };
    }

    case "commit": {
      let msg: string | null = null;
      let all = false;
      let amend = false;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "-m" || a === "--message") msg = rest[++i] ?? null;
        else if (a === "-am" || a === "-ma") {
          all = true;
          msg = rest[++i] ?? null;
        } else if (a.startsWith("-m") && a.length > 2) msg = a.slice(2);
        else if (a === "-a" || a === "--all") all = true;
        else if (a === "--amend") amend = true;
      }
      if (all) {
        g.staged = [...new Set([...g.staged, ...g.modified])];
        g.modified = [];
      }
      if (amend) {
        const last = head(sh)!;
        last.message = msg ?? last.message;
        last.hash = fakeHash(`${last.message}-amend-${g.commits.length}-${g.forcePushes}`);
        return ok(`[${g.branch} ${last.hash}] ${last.message}`, " Date: just now (rewritten; the old one is gone)");
      }
      if (!g.staged.length) {
        if (g.modified.length || g.untracked.length) {
          return { out: ['no changes added to commit (use "git add" and/or "git commit -a")'], code: 1 };
        }
        return { out: ["nothing to commit, working tree clean"], code: 1 };
      }
      if (!msg) return fail("Aborting commit due to empty commit message.");
      const n = g.staged.length;
      const commit = { hash: fakeHash(`${msg}-${g.commits.length}`), message: msg, author: "dev <dev@crypt>", when: "just now" };
      g.commits.push(commit);
      g.staged = [];
      return ok(`[${g.branch} ${commit.hash}] ${msg}`, ` ${n} file${n > 1 ? "s" : ""} changed, ${n * 3} insertions(+), ${n} deletion${n > 1 ? "s" : ""}(-)`);
    }

    case "log": {
      const oneline = hasFlag("--oneline");
      let limit = Infinity;
      const nIdx = rest.indexOf("-n");
      if (nIdx >= 0 && rest[nIdx + 1]) limit = parseInt(rest[nIdx + 1], 10) || limit;
      const numFlag = rest.find((a) => /^-\d+$/.test(a));
      if (numFlag) limit = parseInt(numFlag.slice(1), 10);
      const list = [...g.commits].reverse().slice(0, limit);
      const out: string[] = [];
      for (const c of list) {
        if (oneline) out.push(`${c.hash} ${c.message}`);
        else out.push(`commit ${(c.hash + c.hash + c.hash + c.hash + c.hash).slice(0, 40)}`, `Author: ${c.author}`, `Date:   ${c.when}`, "", `    ${c.message}`, "");
      }
      return { out, code: 0 };
    }

    case "show": {
      const c = head(sh)!;
      return ok(`commit ${(c.hash.repeat(6)).slice(0, 40)}`, `Author: ${c.author}`, `Date:   ${c.when}`, "", `    ${c.message}`);
    }

    case "diff": {
      if (!g.modified.length && !(hasFlag("--staged", "--cached") && g.staged.length)) return { out: [], code: 0 };
      const f = (hasFlag("--staged", "--cached") ? g.staged : g.modified)[0];
      return ok(
        `diff --git a/${f} b/${f}`,
        `index ${fakeHash(f)}..${fakeHash(f + "2")} 100644`,
        `--- a/${f}`,
        `+++ b/${f}`,
        "@@ -1,3 +1,4 @@",
        " // TODO: remove this before the deadline",
        "+// (it is behind you)",
        " export function summon(name) {",
      );
    }

    case "branch": {
      const del = rest.findIndex((a) => a === "-D" || a === "-d");
      if (del >= 0) {
        const name = rest[del + 1];
        if (!name || !g.branches.includes(name)) return fail(`error: branch '${name ?? ""}' not found.`);
        if (name === g.branch) return fail(`error: cannot delete branch '${name}' used by worktree at '${sh.cwd}'`);
        g.branches = g.branches.filter((b) => b !== name);
        return ok(`Deleted branch ${name} (was ${head(sh)!.hash}).`);
      }
      const name = rest.find((a) => !a.startsWith("-"));
      if (name) {
        if (g.branches.includes(name)) return fail(`fatal: a branch named '${name}' already exists`, 128);
        g.branches.push(name);
        return { out: [], code: 0 };
      }
      return { out: g.branches.map((b) => (b === g.branch ? `* ${b}` : `  ${b}`)), code: 0 };
    }

    case "checkout":
    case "switch":
    case "restore": {
      const create = hasFlag("-b", "-c", "-B");
      const names = rest.filter((a) => !a.startsWith("-"));
      if ((names.includes(".") || rest.includes("--")) && !create) {
        const n = g.modified.length;
        g.modified = [];
        return ok(`Updated ${n} path${n === 1 ? "" : "s"} from the index`);
      }
      const target = names[0];
      if (!target) return fail(`error: you must specify a branch`);
      if (create) {
        if (g.branches.includes(target)) return fail(`fatal: a branch named '${target}' already exists`, 128);
        g.branches.push(target);
        g.branch = target;
        return ok(`Switched to a new branch '${target}'`);
      }
      if (!g.branches.includes(target)) return fail(`error: pathspec '${target}' did not match any file(s) known to git`);
      g.branch = target;
      return ok(`Switched to branch '${target}'`);
    }

    case "push":
      return pushOut(sh, hasFlag("--force", "-f"));

    case "pull":
      return ok("Already up to date.");

    case "fetch":
      return { out: [], code: 0 };

    case "merge":
      return ok("Merge made by the 'ort' strategy.", " src/index.js | 2 +-", " 1 file changed, 1 insertion(+), 1 deletion(-)");

    case "rebase":
      if (hasFlag("-i", "--interactive")) return fail("hint: interactive rebase needs an editor; none can be opened in the afterlife", 1);
      return ok(`Successfully rebased and updated refs/heads/${g.branch}.`);

    case "reset": {
      if (hasFlag("--hard")) {
        const ref = rest.find((a) => /^(HEAD[~^]\d*|HEAD~\d+)$/.test(a));
        const steps = ref ? parseInt(ref.replace(/\D/g, ""), 10) || 1 : 0;
        for (let i = 0; i < steps && g.commits.length > 1; i++) g.commits.pop();
        g.staged = [];
        g.modified = [];
        const h = head(sh)!;
        return ok(`HEAD is now at ${h.hash} ${h.message}`);
      }
      const moved = g.staged.length;
      g.modified = [...new Set([...g.modified, ...g.staged])];
      g.staged = [];
      return moved ? ok("Unstaged changes after reset:", ...g.modified.map((f) => `M\t${f}`)) : { out: [], code: 0 };
    }

    case "stash": {
      const action = rest[0] ?? "push";
      if (action === "list") {
        return { out: Array.from({ length: g.stashes }, (_, i) => `stash@{${i}}: WIP on ${g.branch}: ${head(sh)!.hash} ${head(sh)!.message}`), code: 0 };
      }
      if (action === "pop" || action === "apply") {
        if (!g.stashes) return fail("No stash entries found.");
        if (action === "pop") g.stashes--;
        g.modified = [...new Set([...g.modified, "src/index.js"])];
        return ok(...status(sh).out!.slice(0, 1), "Dropped refs/stash@{0}");
      }
      if (action === "drop" || action === "clear") {
        if (!g.stashes) return fail("No stash entries found.");
        g.stashes = action === "clear" ? 0 : g.stashes - 1;
        return ok(`Dropped refs/stash@{0} (${fakeHash("stash")})`);
      }
      if (!g.modified.length && !g.staged.length) return ok("No local changes to save");
      g.stashes++;
      g.modified = [];
      g.staged = [];
      return ok(`Saved working directory and index state WIP on ${g.branch}: ${head(sh)!.hash} ${head(sh)!.message}`);
    }

    case "clean": {
      if (!hasFlag("-f", "-fd", "-fdx", "-df", "-xdf", "--force")) {
        return fail("fatal: clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean", 128);
      }
      const removed = [...g.untracked];
      for (const f of removed) removeNode(sh.fs, normalizePath(sh.cwd, f, sh.home));
      g.untracked = [];
      return { out: removed.map((f) => `Removing ${f}`), code: 0 };
    }

    case "revert": {
      const h = head(sh)!;
      const c = { hash: fakeHash(`revert-${h.hash}-${g.commits.length}`), message: `Revert "${h.message}"`, author: "dev <dev@crypt>", when: "just now" };
      g.commits.push(c);
      return ok(`[${g.branch} ${c.hash}] ${c.message}`, " 1 file changed, 1 insertion(+), 3 deletions(-)");
    }

    case "remote":
      return hasFlag("-v")
        ? ok("origin\tgit@github.com:dev/haunted-project.git (fetch)", "origin\tgit@github.com:dev/haunted-project.git (push)")
        : ok("origin");

    case "tag":
      return { out: [], code: 0 };

    case "init":
      return ok(`Reinitialized existing Git repository in ${sh.cwd}/.git/`);

    case "config":
      return { out: [], code: 0 };

    case "clone": {
      const url = rest.find((a) => !a.startsWith("-")) ?? "repository";
      const host = url.match(/(?:@|\/\/)([^/:]+)/)?.[1] ?? "github.com";
      return fail(`fatal: unable to access '${url}': Could not resolve host: ${host}`, 128);
    }

    default:
      return fail(`git: '${sub}' is not a git command. See 'git --help'.`);
  }
};
