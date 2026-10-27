import type { GitState, ShellState, VNode } from "./types.ts";

export function dir(children: Record<string, VNode> = {}): VNode {
  return { type: "dir", children };
}

export function file(content = ""): VNode {
  return { type: "file", content };
}

/** Resolve `input` against `cwd` into a normalised absolute path. Supports ~ . and .. */
export function normalizePath(cwd: string, input: string, home: string): string {
  let p = input;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + p.slice(1);
  if (!p.startsWith("/")) p = `${cwd}/${p}`;
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export function getNode(root: VNode, abs: string): VNode | undefined {
  let node: VNode = root;
  for (const part of abs.split("/").filter(Boolean)) {
    if (node.type !== "dir") return undefined;
    const next: VNode | undefined = node.children[part];
    if (!next) return undefined;
    node = next;
  }
  return node;
}

export function splitParent(abs: string): { parent: string; name: string } {
  const idx = abs.lastIndexOf("/");
  return { parent: idx <= 0 ? "/" : abs.slice(0, idx), name: abs.slice(idx + 1) };
}

export function writeFile(root: VNode, abs: string, content: string, append = false): boolean {
  const { parent, name } = splitParent(abs);
  const p = getNode(root, parent);
  if (!p || p.type !== "dir" || !name) return false;
  const existing = p.children[name];
  if (existing && existing.type === "dir") return false;
  const prev = append && existing && existing.type === "file" ? existing.content : "";
  p.children[name] = file(prev + content);
  return true;
}

export type MkdirResult = "ok" | "exists" | "noparent";

export function makeDir(root: VNode, abs: string, recursive: boolean): MkdirResult {
  if (getNode(root, abs)) return "exists";
  const { parent, name } = splitParent(abs);
  let p = getNode(root, parent);
  if (!p && recursive) {
    makeDir(root, parent, true);
    p = getNode(root, parent);
  }
  if (!p || p.type !== "dir" || !name) return "noparent";
  p.children[name] = dir();
  return "ok";
}

export function removeNode(root: VNode, abs: string): boolean {
  const { parent, name } = splitParent(abs);
  const p = getNode(root, parent);
  if (!p || p.type !== "dir" || !p.children[name]) return false;
  delete p.children[name];
  return true;
}

export function displayPath(abs: string, home: string): string {
  if (abs === home) return "~";
  if (abs.startsWith(home + "/")) return "~" + abs.slice(home.length);
  return abs;
}

export function sortedEntries(node: VNode): [string, VNode][] {
  if (node.type !== "dir") return [];
  return Object.entries(node.children).sort(([a, an], [b, bn]) => {
    if (an.type !== bn.type) return an.type === "dir" ? -1 : 1;
    return a.localeCompare(b);
  });
}

/** djb2 hash rendered as a 7 char hex string: a stable fake commit id. */
export function fakeHash(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return (hex + hex).slice(0, 7);
}

const PACKAGE_JSON = `{
  "name": "haunted-project",
  "version": "0.6.6",
  "description": "Something is wrong with this repository.",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "jest --haunted"
  },
  "dependencies": {
    "left-pad": "1.3.0",
    "react": "^19.0.0"
  }
}
`;

const README = `# haunted-project

> It worked on my machine. My machine is no longer with us.

## Install
\`npm install\` (and do not look at node_modules at night)
`;

const INDEX_JS = `// TODO: remove this before the deadline
export function summon(name) {
  return \`Hello, \${name}. We have been expecting you.\`;
}
`;

const GRAVEYARD_JS = `// Dead code lives here. Do not resurrect without a ritual.
export const legacy = () => { throw new Error("it was already dead"); };
`;

export function createSeedFs(): VNode {
  return dir({
    home: dir({
      dev: dir({
        notes: dir({
          "cursed.txt": file("never merge on a friday\nnever trust a green CI on a full moon\n"),
        }),
        ".bash_history": file("sudo make me a sandwich\nvim\n:q!\n:q!\n:q!\n"),
        "haunted-project": dir({
          ".git": dir({ HEAD: file("ref: refs/heads/main\n") }),
          ".env": file("DATABASE_URL=postgres://admin:hunter2@10.0.0.13/prod\nSECRET_KEY=do-not-commit-this\n"),
          "package.json": file(PACKAGE_JSON),
          "README.md": file(README),
          "TODO.md": file("- fix the thing\n- (the thing is behind you)\n"),
          src: dir({
            "index.js": file(INDEX_JS),
            "graveyard.js": file(GRAVEYARD_JS),
          }),
          node_modules: dir({
            "left-pad": dir({ "index.js": file("module.exports = () => {};\n") }),
            ".package-lock.json": file("{}\n"),
          }),
        }),
      }),
    }),
    etc: dir({ hostname: file("crypt\n") }),
    tmp: dir(),
  });
}

export function createSeedGit(): GitState {
  const commits = [
    { message: "initial commit (it was quiet then)", when: "3 months ago" },
    { message: "add summoning circle", when: "2 months ago" },
    { message: "fix: the thing", when: "3 weeks ago" },
    { message: "fix: the thing, for real this time", when: "2 days ago" },
  ].map((c, i) => ({ ...c, author: "dev <dev@crypt>", hash: fakeHash(`seed-${i}-${c.message}`) }));
  return {
    branch: "main",
    branches: ["main", "feature/necromancy"],
    commits,
    staged: [],
    modified: ["src/index.js"],
    untracked: ["TODO.md"],
    forcePushes: 0,
    stashes: 0,
  };
}

export function createShell(): ShellState {
  return {
    fs: createSeedFs(),
    cwd: "/home/dev/haunted-project",
    home: "/home/dev",
    user: "dev",
    host: "crypt",
    history: [],
    git: createSeedGit(),
    lastExit: 0,
    errorStreak: 0,
    commandCount: 0,
  };
}
