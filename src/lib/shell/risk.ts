/**
 * Command Interceptor: classifies a raw command line into a category and a
 * "dread" score (0-3). The ghost uses it to decide whether to speak at all and
 * how theatrically. It is deliberately heuristic: regexes, not a parser.
 */

export type Category =
  | "destructive"
  | "history"
  | "secrets"
  | "privilege"
  | "network"
  | "install"
  | "build"
  | "vcs"
  | "editor"
  | "navigation"
  | "inspect"
  | "create"
  | "meta"
  | "unknown";

export type Dread = 0 | 1 | 2 | 3;

export interface Risk {
  category: Category;
  dread: Dread;
  /** Specific tags, most important first. The scripted ghost keys its lore on these. */
  tags: string[];
  /** One-line, human readable consequence. Fed to the model as grounding. */
  summary: string;
}

const TAG_SUMMARY: Record<string, string> = {
  apocalypse: "recursive deletion aimed at the root, home or everything in the current directory",
  "rm-rf": "forced recursive deletion that cannot be undone",
  "rm-r": "recursive deletion",
  rm: "deleting files, which is a small death",
  cleanse: "clearing build artefacts, a routine ritual cleansing",
  "force-push": "force pushing rewrites shared remote history and can erase teammates' commits",
  "force-lease": "force pushing with a lease, safer but still rewriting remote history",
  "reset-hard": "hard reset discards uncommitted work permanently",
  "git-clean": "git clean deletes untracked files permanently",
  discard: "discarding working tree changes permanently",
  amend: "amending rewrites the previous commit",
  rebase: "rebasing rewrites commit history",
  "branch-delete": "force deleting a branch can orphan its commits",
  "stash-drop": "dropping a stash destroys saved work",
  "history-surgery": "rewriting the whole repository history",
  secrets: "reading files that probably contain secrets",
  sudo: "running with elevated privileges",
  chmod: "opening permissions wide for everyone",
  kill: "forcefully killing processes",
  "curl-pipe": "piping a download straight into a shell executes unreviewed code",
  "disk-destroy": "writing directly to disks or filesystems",
  "fork-bomb": "a fork bomb that exhausts the machine",
  sql: "destructive SQL against a database",
  "iac-destroy": "tearing down infrastructure",
  "audit-force": "forcing dependency fixes that may break the build",
  publish: "publishing a package, which is very hard to take back",
  "npm-install": "installing dependencies and the weight of node_modules",
  build: "building the project",
  test: "running the test suite",
  commit: "creating a commit",
  add: "staging changes",
  status: "inspecting repository status",
  log: "reading commit history",
  diff: "reading a diff",
  push: "pushing commits to the remote",
  pull: "pulling from the remote",
  branch: "working with branches",
  checkout: "switching branches",
  merge: "merging branches",
  stash: "stashing work",
  vim: "opening vim, from which escape is not guaranteed",
  emacs: "opening emacs, in defiance of the editor wars",
  nano: "opening nano, the editor of the cautious",
  editor: "opening an editor",
  exit: "leaving the terminal",
  network: "using the network",
  docker: "container tooling",
  ls: "listing files",
  pwd: "printing the working directory",
  cd: "changing directory",
  whoami: "asking who you are",
  date: "asking the time",
  cat: "reading a file",
  echo: "echoing text",
  clear: "clearing the screen",
  history: "reading shell history",
  tree: "listing the directory tree",
  create: "creating files or directories",
  help: "asking for help",
  man: "asking for a manual",
  ps: "listing processes",
  uptime: "asking how long the machine has been awake",
  node: "running node",
  ghost: "talking to the ghost",
  unknown: "an unrecognised command",
};

export function describeTag(tag: string): string {
  return TAG_SUMMARY[tag] ?? tag;
}

interface Assessment {
  category: Category;
  dread: Dread;
  tags: string[];
}

const SAFE_RM_TARGET = /(^|\/)(node_modules|dist|build|out|coverage|tmp|\.next|\.cache|\.turbo)\/?$/;
const APOCALYPSE_TARGET = /^(\/|\/\*|~|~\/|~\/\*|\*|\.|\.\.|\.\/\*|\$HOME)$/;

function tokens(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
}

function assessRm(args: string[]): Assessment {
  const flags = args.filter((a) => a.startsWith("-"));
  const targets = args.filter((a) => !a.startsWith("-"));
  const joined = flags.join("");
  const recursive = /r|R/.test(joined) || flags.includes("--recursive");
  const force = /f/.test(joined) || flags.includes("--force");
  if (recursive && targets.some((t) => APOCALYPSE_TARGET.test(t))) {
    return { category: "destructive", dread: 3, tags: ["apocalypse", "rm-rf"] };
  }
  if (recursive && targets.length > 0 && targets.every((t) => SAFE_RM_TARGET.test(t))) {
    return { category: "destructive", dread: 1, tags: ["cleanse"] };
  }
  if (recursive && force) return { category: "destructive", dread: 3, tags: ["rm-rf"] };
  if (recursive) return { category: "destructive", dread: 2, tags: ["rm-r"] };
  return { category: "destructive", dread: 1, tags: ["rm"] };
}

function assessGit(args: string[], segment: string): Assessment {
  const sub = args[0] ?? "";
  const has = (re: RegExp) => re.test(segment);
  switch (sub) {
    case "push":
      if (has(/--force-with-lease/)) return { category: "history", dread: 2, tags: ["force-lease", "push"] };
      if (has(/(^|\s)(--force|-f)(\s|$)/)) return { category: "history", dread: 3, tags: ["force-push", "push"] };
      return { category: "vcs", dread: 1, tags: ["push"] };
    case "reset":
      if (has(/--hard/)) return { category: "history", dread: 3, tags: ["reset-hard"] };
      return { category: "vcs", dread: 1, tags: ["branch"] };
    case "clean":
      if (has(/(^|\s)-[a-z]*f/)) return { category: "destructive", dread: 3, tags: ["git-clean"] };
      return { category: "vcs", dread: 1, tags: ["git-clean"] };
    case "checkout":
    case "restore":
      if (has(/(\s--\s+\.|\s\.$)/)) return { category: "destructive", dread: 2, tags: ["discard", "checkout"] };
      return { category: "vcs", dread: 1, tags: ["checkout"] };
    case "switch":
      return { category: "vcs", dread: 1, tags: ["checkout"] };
    case "branch":
      if (has(/\s-D(\s|$)/)) return { category: "history", dread: 2, tags: ["branch-delete", "branch"] };
      return { category: "vcs", dread: 1, tags: ["branch"] };
    case "stash":
      if (/^(drop|clear)$/.test(args[1] ?? "")) return { category: "destructive", dread: 2, tags: ["stash-drop", "stash"] };
      return { category: "vcs", dread: 1, tags: ["stash"] };
    case "rebase":
      return { category: "history", dread: 2, tags: ["rebase"] };
    case "commit":
      if (has(/--amend/)) return { category: "history", dread: 2, tags: ["amend", "commit"] };
      return { category: "vcs", dread: 1, tags: ["commit"] };
    case "filter-branch":
    case "filter-repo":
      return { category: "history", dread: 3, tags: ["history-surgery"] };
    case "add":
      return { category: "vcs", dread: 1, tags: ["add"] };
    case "status":
      return { category: "vcs", dread: 1, tags: ["status"] };
    case "log":
    case "show":
    case "blame":
      return { category: "vcs", dread: 1, tags: ["log"] };
    case "diff":
      return { category: "vcs", dread: 1, tags: ["diff"] };
    case "pull":
    case "fetch":
      return { category: "vcs", dread: 1, tags: ["pull"] };
    case "merge":
      return { category: "vcs", dread: 1, tags: ["merge"] };
    default:
      return { category: "vcs", dread: 1, tags: ["status"] };
  }
}

function assessSegment(raw: string): Assessment & { sudo: boolean } {
  let segment = raw.trim();
  let sudo = false;
  if (/^sudo\s/.test(segment)) {
    sudo = true;
    segment = segment.replace(/^sudo\s+(-\S+\s+)*/, "");
  }
  const toks = tokens(segment);
  const cmd = toks[0] ?? "";
  const args = toks.slice(1);
  const finish = (p: Assessment) => ({ ...p, sudo });

  if (!cmd) return finish({ category: "unknown", dread: 0, tags: [] });

  if (/DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE/i.test(segment)) {
    return finish({ category: "destructive", dread: 3, tags: ["sql"] });
  }

  switch (cmd) {
    case "rm":
      return finish(assessRm(args));
    case "git":
      return finish(assessGit(args, segment));
    case "dd":
    case "mkfs":
    case "shred":
    case "wipefs":
      return finish({ category: "destructive", dread: 3, tags: ["disk-destroy"] });
    case "chmod":
      if (/777/.test(segment)) return finish({ category: "destructive", dread: 2, tags: ["chmod"] });
      return finish({ category: "create", dread: 0, tags: ["create"] });
    case "chown":
      return finish({ category: "destructive", dread: 2, tags: ["chmod"] });
    case "kill":
    case "killall":
    case "pkill":
      return finish({ category: "destructive", dread: /-9|-KILL/.test(segment) ? 2 : 1, tags: ["kill"] });
    case "curl":
    case "wget":
      return finish({ category: "network", dread: 1, tags: ["network"] });
    case "ssh":
    case "scp":
    case "rsync":
    case "ping":
    case "nc":
    case "telnet":
      return finish({ category: "network", dread: 1, tags: ["network"] });
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun": {
      const sub = args[0] ?? "";
      if (sub === "audit" && /--force/.test(segment)) return finish({ category: "install", dread: 2, tags: ["audit-force", "npm-install"] });
      if (sub === "publish") return finish({ category: "network", dread: 2, tags: ["publish"] });
      if (/^(i|install|ci|add|update|upgrade)$/.test(sub) || (cmd === "yarn" && !sub)) {
        return finish({ category: "install", dread: 1, tags: ["npm-install"] });
      }
      if (sub === "test" || sub === "t") return finish({ category: "build", dread: 1, tags: ["test", "build"] });
      return finish({ category: "build", dread: 1, tags: ["build"] });
    }
    case "npx":
    case "node":
    case "tsc":
    case "vite":
    case "next":
      return finish({ category: "build", dread: 1, tags: ["build", "node"] });
    case "docker":
    case "docker-compose":
    case "podman":
      if (/system\s+prune|volume\s+(rm|prune)|rm\s+-f|rmi\s+-f/.test(segment)) {
        return finish({ category: "destructive", dread: 2, tags: ["iac-destroy", "docker"] });
      }
      return finish({ category: "build", dread: 1, tags: ["docker"] });
    case "kubectl":
    case "terraform":
      if (/\b(delete|destroy)\b/.test(segment)) return finish({ category: "destructive", dread: 3, tags: ["iac-destroy"] });
      return finish({ category: "build", dread: 1, tags: ["docker"] });
    case "vim":
    case "vi":
    case "nvim":
      return finish({ category: "editor", dread: 1, tags: ["vim", "editor"] });
    case "emacs":
      return finish({ category: "editor", dread: 1, tags: ["emacs", "editor"] });
    case "nano":
    case "code":
      return finish({ category: "editor", dread: 1, tags: ["nano", "editor"] });
    case "exit":
    case "logout":
      return finish({ category: "meta", dread: 1, tags: ["exit"] });
    case "cat":
    case "less":
    case "more":
    case "head":
    case "tail":
    case "grep":
    case "bat":
      if (/(\.env|id_rsa|\.pem|secret|credential|\.npmrc)/i.test(segment)) {
        return finish({ category: "secrets", dread: 2, tags: ["secrets", "cat"] });
      }
      return finish({ category: "inspect", dread: 0, tags: ["cat"] });
    case "ls":
    case "ll":
    case "la":
      return finish({ category: "inspect", dread: 0, tags: ["ls"] });
    case "tree":
      return finish({ category: "inspect", dread: 0, tags: ["tree", "ls"] });
    case "pwd":
      return finish({ category: "navigation", dread: 0, tags: ["pwd"] });
    case "cd":
      return finish({ category: "navigation", dread: 0, tags: ["cd"] });
    case "whoami":
    case "id":
      return finish({ category: "inspect", dread: 0, tags: ["whoami"] });
    case "date":
      return finish({ category: "inspect", dread: 0, tags: ["date"] });
    case "uptime":
      return finish({ category: "inspect", dread: 0, tags: ["uptime"] });
    case "echo":
      return finish({ category: "inspect", dread: 0, tags: ["echo"] });
    case "clear":
      return finish({ category: "meta", dread: 0, tags: ["clear"] });
    case "history":
      return finish({ category: "inspect", dread: 0, tags: ["history"] });
    case "ps":
    case "top":
    case "htop":
      return finish({ category: "inspect", dread: 0, tags: ["ps"] });
    case "man":
    case "help":
      return finish({ category: "meta", dread: 0, tags: ["help"] });
    case "touch":
    case "mkdir":
    case "cp":
    case "mv":
      return finish({ category: "create", dread: 0, tags: ["create"] });
    case "ghost":
    case "seance":
    case "exorcise":
      return finish({ category: "meta", dread: 0, tags: ["ghost"] });
    default:
      return finish({ category: "unknown", dread: 0, tags: ["unknown"] });
  }
}

export function assessCommand(raw: string): Risk {
  const line = raw.trim();
  if (!line) return { category: "unknown", dread: 0, tags: [], summary: "an empty command" };

  // Whole-line patterns that span pipes and chains.
  if (/(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(line)) {
    return { category: "network", dread: 3, tags: ["curl-pipe", "network"], summary: describeTag("curl-pipe") };
  }
  if (/:\(\)\s*\{\s*:\s*\|\s*:/.test(line)) {
    return { category: "destructive", dread: 3, tags: ["fork-bomb"], summary: describeTag("fork-bomb") };
  }

  const segments = line.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  let best: (Assessment & { sudo: boolean }) | null = null;
  let anySudo = false;
  for (const seg of segments) {
    const a = assessSegment(seg);
    anySudo = anySudo || a.sudo;
    if (!best || a.dread > best.dread) best = a;
  }
  const chosen = best ?? { category: "unknown" as Category, dread: 0 as Dread, tags: [], sudo: false };
  const tags = [...chosen.tags];
  let dread = chosen.dread;
  let category = chosen.category;
  if (anySudo) {
    tags.unshift("sudo");
    dread = Math.min(3, dread + 1) as Dread;
    if (category === "unknown" || category === "inspect") category = "privilege";
  }
  const primary = tags[0] ?? "unknown";
  return { category, dread, tags, summary: describeTag(primary) };
}
