import type { Cmd, CmdOut, Ctx } from "./cmd-types.ts";
import { fail, ok } from "./cmd-types.ts";
import { git } from "./git.ts";
import { PERSONAS, getPersona } from "../ghost/personas.ts";
import type { GhostLevel, VNode } from "./types.ts";
import { getNode, makeDir, normalizePath, removeNode, sortedEntries, splitParent, writeFile } from "./vfs.ts";

const resolve = (ctx: Ctx, p: string) => normalizePath(ctx.sh.cwd, p, ctx.sh.home);

function readLines(ctx: Ctx, p: string): { lines: string[] } | { error: string } {
  const node = getNode(ctx.sh.fs, resolve(ctx, p));
  if (!node) return { error: `${p}: No such file or directory` };
  if (node.type === "dir") return { error: `${p}: Is a directory` };
  const text = node.content.endsWith("\n") ? node.content.slice(0, -1) : node.content;
  return { lines: text === "" ? [] : text.split("\n") };
}

function flagsAndOperands(args: string[]): { flags: Set<string>; operands: string[] } {
  const flags = new Set<string>();
  const operands: string[] = [];
  for (const a of args) {
    if (/^-[a-zA-Z]+$/.test(a)) for (const ch of a.slice(1)) flags.add(ch);
    else if (a.startsWith("--")) flags.add(a);
    else operands.push(a);
  }
  return { flags, operands };
}

// ---------------------------------------------------------------- filesystem

const ls: Cmd = (ctx, args) => {
  const { flags, operands } = flagsAndOperands(args);
  const targets = operands.length ? operands : ["."];
  const out: string[] = [];
  const err: string[] = [];
  const long = flags.has("l");
  const all = flags.has("a") || flags.has("A");

  const fmt = (name: string, node: VNode) => {
    if (!long) return node.type === "dir" ? `${name}/` : name;
    const size = node.type === "file" ? node.content.length : 4096;
    return `${node.type === "dir" ? "drwxr-xr-x" : "-rw-r--r--"} 1 dev dev ${String(size).padStart(5)} Oct 31 00:00 ${name}`;
  };

  targets.forEach((t, idx) => {
    const node = getNode(ctx.sh.fs, resolve(ctx, t));
    if (!node) {
      err.push(`ls: cannot access '${t}': No such file or directory`);
      return;
    }
    if (targets.length > 1) out.push(`${idx ? "\n" : ""}${t}:`);
    if (node.type === "file") {
      out.push(fmt(t, node));
      return;
    }
    let entries = sortedEntries(node);
    if (!all) entries = entries.filter(([n]) => !n.startsWith("."));
    const names = entries.map(([n, v]) => fmt(n, v));
    if (all) {
      names.unshift(...(long ? [fmt(".", node), fmt("..", node)] : [".", ".."]));
    }
    if (long) out.push(`total ${entries.length * 4}`, ...names);
    else if (names.length) out.push(names.join("  "));
  });
  return { out, err, code: err.length ? 2 : 0 };
};

const cd: Cmd = (ctx, args) => {
  const target = args[0] ?? "~";
  const abs = resolve(ctx, target);
  const node = getNode(ctx.sh.fs, abs);
  if (!node) return fail(`bash: cd: ${target}: No such file or directory`);
  if (node.type !== "dir") return fail(`bash: cd: ${target}: Not a directory`);
  ctx.sh.cwd = abs;
  return { code: 0 };
};

const pwd: Cmd = (ctx) => ok(ctx.sh.cwd);

const cat: Cmd = (ctx, args) => {
  const files = args.filter((a) => !a.startsWith("-"));
  if (!files.length) return ctx.stdin ? { out: ctx.stdin, code: 0 } : { code: 0 };
  const out: string[] = [];
  const err: string[] = [];
  for (const f of files) {
    const r = readLines(ctx, f);
    if ("error" in r) err.push(`cat: ${r.error}`);
    else out.push(...r.lines);
  }
  return { out, err, code: err.length ? 1 : 0 };
};

const echo: Cmd = (_ctx, args) => {
  const a = args[0] === "-n" ? args.slice(1) : args;
  return ok(a.join(" "));
};

const mkdir: Cmd = (ctx, args) => {
  const { flags, operands } = flagsAndOperands(args);
  if (!operands.length) return fail("mkdir: missing operand");
  const err: string[] = [];
  for (const o of operands) {
    const r = makeDir(ctx.sh.fs, resolve(ctx, o), flags.has("p"));
    if (r === "exists" && !flags.has("p")) err.push(`mkdir: cannot create directory '${o}': File exists`);
    if (r === "noparent") err.push(`mkdir: cannot create directory '${o}': No such file or directory`);
  }
  return { err, code: err.length ? 1 : 0 };
};

const touch: Cmd = (ctx, args) => {
  const err: string[] = [];
  for (const o of args.filter((a) => !a.startsWith("-"))) {
    const abs = resolve(ctx, o);
    if (getNode(ctx.sh.fs, abs)) continue;
    if (!writeFile(ctx.sh.fs, abs, "")) err.push(`touch: cannot touch '${o}': No such file or directory`);
  }
  return { err, code: err.length ? 1 : 0 };
};

const rm: Cmd = (ctx, args) => {
  const { flags, operands } = flagsAndOperands(args);
  const recursive = flags.has("r") || flags.has("R") || flags.has("--recursive");
  const force = flags.has("f") || flags.has("--force");
  if (!operands.length) return force ? { code: 0 } : fail("rm: missing operand");

  // The GNU failsafe, and a harmless pantomime for everything below it.
  if (recursive && operands.some((o) => o === "/")) {
    if (flags.has("--no-preserve-root")) return { out: ["Segmentation fault (core dumped)"], code: 139 };
    return { err: ["rm: it is dangerous to operate recursively on '/'", "rm: use --no-preserve-root to override this failsafe"], code: 1 };
  }
  if (recursive && operands.some((o) => o === "/*")) {
    if (ctx.sudo) return { out: ["Segmentation fault (core dumped)"], code: 139 };
    return {
      err: ["/bin", "/boot", "/etc", "/home", "/usr", "/var"].map((d) => `rm: cannot remove '${d}': Permission denied`),
      code: 1,
    };
  }
  if (operands.some((o) => o === "." || o === "..")) {
    return fail(`rm: refusing to remove '.' or '..' directory: skipping '${operands.find((o) => o === "." || o === "..")}'`);
  }

  const err: string[] = [];
  for (const o of operands) {
    const abs = resolve(ctx, o);
    const node = getNode(ctx.sh.fs, abs);
    if (!node) {
      if (!force) err.push(`rm: cannot remove '${o}': No such file or directory`);
      continue;
    }
    if (node.type === "dir" && !recursive) {
      err.push(`rm: cannot remove '${o}': Is a directory`);
      continue;
    }
    removeNode(ctx.sh.fs, abs);
  }
  return { err, code: err.length ? 1 : 0 };
};

function copyOrMove(name: "cp" | "mv"): Cmd {
  return (ctx, args) => {
    const { flags, operands } = flagsAndOperands(args);
    if (operands.length < 2) return fail(`${name}: missing destination file operand after '${operands[0] ?? ""}'`);
    const dest = operands[operands.length - 1];
    const sources = operands.slice(0, -1);
    const destAbs = resolve(ctx, dest);
    const destNode = getNode(ctx.sh.fs, destAbs);
    const err: string[] = [];
    for (const s of sources) {
      const srcAbs = resolve(ctx, s);
      const node = getNode(ctx.sh.fs, srcAbs);
      if (!node) {
        err.push(`${name}: cannot stat '${s}': No such file or directory`);
        continue;
      }
      if (node.type === "dir" && name === "cp" && !flags.has("r") && !flags.has("R")) {
        err.push(`cp: -r not specified; omitting directory '${s}'`);
        continue;
      }
      const base = splitParent(srcAbs).name;
      const finalAbs = destNode && destNode.type === "dir" ? `${destAbs}/${base}` : destAbs;
      const { parent, name: leaf } = splitParent(finalAbs);
      const parentNode = getNode(ctx.sh.fs, parent);
      if (!parentNode || parentNode.type !== "dir") {
        err.push(`${name}: cannot create '${dest}': No such file or directory`);
        continue;
      }
      parentNode.children[leaf] = structuredClone(node);
      if (name === "mv" && finalAbs !== srcAbs) removeNode(ctx.sh.fs, srcAbs);
    }
    return { err, code: err.length ? 1 : 0 };
  };
}

const head: Cmd = (ctx, args) => {
  let n = 10;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n") n = parseInt(args[++i] ?? "10", 10) || 10;
    else if (/^-\d+$/.test(args[i])) n = parseInt(args[i].slice(1), 10);
    else if (!args[i].startsWith("-")) files.push(args[i]);
  }
  if (!files.length) return { out: (ctx.stdin ?? []).slice(0, n), code: 0 };
  const r = readLines(ctx, files[0]);
  return "error" in r ? fail(`head: ${r.error}`) : { out: r.lines.slice(0, n), code: 0 };
};

const tail: Cmd = (ctx, args) => {
  let n = 10;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n") n = parseInt(args[++i] ?? "10", 10) || 10;
    else if (/^-\d+$/.test(args[i])) n = parseInt(args[i].slice(1), 10);
    else if (!args[i].startsWith("-")) files.push(args[i]);
  }
  if (!files.length) return { out: (ctx.stdin ?? []).slice(-n), code: 0 };
  const r = readLines(ctx, files[0]);
  return "error" in r ? fail(`tail: ${r.error}`) : { out: r.lines.slice(-n), code: 0 };
};

const grep: Cmd = (ctx, args) => {
  const flagArgs = args.filter((a) => /^-[inv]+$/.test(a));
  const rest = args.filter((a) => !/^-[inv]+$/.test(a));
  const ignoreCase = flagArgs.some((f) => f.includes("i"));
  const numbered = flagArgs.some((f) => f.includes("n"));
  const invert = flagArgs.some((f) => f.includes("v"));
  const pattern = rest.shift();
  if (pattern === undefined) return fail("Usage: grep [OPTION]... PATTERNS [FILE]...", 2);
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "");
  }
  const sources: { name: string | null; lines: string[] }[] = [];
  const err: string[] = [];
  if (!rest.length) sources.push({ name: null, lines: ctx.stdin ?? [] });
  for (const f of rest) {
    const r = readLines(ctx, f);
    if ("error" in r) err.push(`grep: ${r.error}`);
    else sources.push({ name: rest.length > 1 ? f : null, lines: r.lines });
  }
  const out: string[] = [];
  for (const s of sources) {
    s.lines.forEach((line, i) => {
      if (re.test(line) !== invert) out.push(`${s.name ? s.name + ":" : ""}${numbered ? i + 1 + ":" : ""}${line}`);
    });
  }
  return { out, err, code: out.length ? 0 : 1 };
};

const wc: Cmd = (ctx, args) => {
  const files = args.filter((a) => !a.startsWith("-"));
  if (!files.length) return ok(String((ctx.stdin ?? []).length));
  const r = readLines(ctx, files[0]);
  return "error" in r ? fail(`wc: ${r.error}`) : ok(`${r.lines.length} ${files[0]}`);
};

const tree: Cmd = (ctx, args) => {
  const target = args.find((a) => !a.startsWith("-")) ?? ".";
  const node = getNode(ctx.sh.fs, resolve(ctx, target));
  if (!node) return fail(`${target} [error opening dir]`);
  const out = [target];
  const counts = { d: 0, f: 0 };
  const walk = (n: VNode, prefix: string) => {
    const entries = sortedEntries(n).filter(([name]) => !name.startsWith("."));
    entries.forEach(([name, child], i) => {
      const last = i === entries.length - 1;
      out.push(`${prefix}${last ? "└── " : "├── "}${name}`);
      if (child.type === "dir") {
        counts.d++;
        if (name !== "node_modules") walk(child, prefix + (last ? "    " : "│   "));
      } else counts.f++;
    });
  };
  if (node.type === "dir") walk(node, "");
  out.push("", `${counts.d} director${counts.d === 1 ? "y" : "ies"}, ${counts.f} file${counts.f === 1 ? "" : "s"}`);
  return { out, code: 0 };
};

const chmod: Cmd = (ctx, args) => {
  const targets = args.filter((a) => !a.startsWith("-")).slice(1);
  for (const t of targets) {
    if (!getNode(ctx.sh.fs, resolve(ctx, t))) return fail(`chmod: cannot access '${t}': No such file or directory`);
  }
  return { code: 0 };
};

// ------------------------------------------------------------------- system

const whoami: Cmd = (ctx) => ok(ctx.sudo ? "root" : ctx.sh.user);
const hostname: Cmd = (ctx) => ok(ctx.sh.host);
const uname: Cmd = (_ctx, args) =>
  ok(args.includes("-a") ? "Linux crypt 6.6.6-haunted #1 SMP PREEMPT_DYNAMIC Fri Oct 31 00:00:00 UTC 2026 x86_64 GNU/Linux" : "Linux");
const date: Cmd = () => ok(new Date().toString());
const uptime: Cmd = () => ok(" 00:00:13 up 666 days,  6:06,  1 user,  load average: 0.66, 0.66, 0.66");
const history: Cmd = (ctx) => ({ out: ctx.sh.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`), code: 0 });
const env: Cmd = (ctx) =>
  ok(`USER=${ctx.sh.user}`, `HOME=${ctx.sh.home}`, `PWD=${ctx.sh.cwd}`, "SHELL=/bin/bash", "TERM=xterm-256color", "HAUNTED=1", "LANG=en_US.UTF-8");
const which: Cmd = (_ctx, args) => {
  const name = args[0];
  if (!name) return { code: 1 };
  return COMMAND_NAMES.includes(name) ? ok(`/usr/bin/${name}`) : { code: 1 };
};
const man: Cmd = (_ctx, args) => fail(`No manual entry for ${args[0] ?? "that"}. The dead write no documentation.`);
const ps: Cmd = () =>
  ok(
    "  PID TTY          TIME CMD",
    "    1 ?        00:00:00 init",
    "  666 pts/0    00:00:00 bash",
    "  667 pts/0    00:00:00 ghostd",
    " 1313 pts/0    00:00:00 ps",
  );
const sleep: Cmd = () => ({ code: 0 });
const kill: Cmd = (_ctx, args) => {
  const pid = args.find((a) => /^\d+$/.test(a));
  return pid ? fail(`bash: kill: (${pid}) - No such process`) : fail("kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]");
};
const clear: Cmd = () => ({ clear: true, code: 0 });
const exit: Cmd = () => ({ actions: [{ type: "exit" }], code: 0 });

// ------------------------------------------------------------------ network
// The shell is deliberately offline. That is the point of the project.

const hostFrom = (args: string[]) => {
  const raw = args.find((a) => !a.startsWith("-")) ?? "host";
  return raw.replace(/^[a-z]+:\/\//, "").replace(/^[^@]*@/, "").split(/[/:]/)[0] || raw;
};
const curl: Cmd = (_c, a) => fail(`curl: (6) Could not resolve host: ${hostFrom(a)}`, 6);
const wget: Cmd = (_c, a) => fail(`wget: unable to resolve host address '${hostFrom(a)}'`, 4);
const ping: Cmd = (_c, a) => fail(`ping: ${hostFrom(a)}: Temporary failure in name resolution`, 2);
const ssh: Cmd = (_c, a) => fail(`ssh: Could not resolve hostname ${hostFrom(a)}: Name or service not known`, 255);

const editor = (name: string): Cmd => (ctx, args) => {
  const target = args.find((a) => !a.startsWith("-"));
  const lines = [`[${name}: the simulated shell has no editor, ${target ? `so '${target}' was not opened` : "so nothing was opened"}]`];
  if (name === "vim" || name === "vi" || name === "nvim") lines.push("(you are free. :q would have worked anyway.)");
  return { out: lines, code: 0 };
};

// --------------------------------------------------------------- node / npm

function readPackageJson(ctx: Ctx): { scripts: Record<string, string>; name: string; version: string } | null {
  const node = getNode(ctx.sh.fs, resolve(ctx, "package.json"));
  if (!node || node.type !== "file") return null;
  try {
    const json = JSON.parse(node.content) as { scripts?: Record<string, string>; name?: string; version?: string };
    return { scripts: json.scripts ?? {}, name: json.name ?? "unnamed", version: json.version ?? "0.0.0" };
  } catch {
    return null;
  }
}

function runScript(ctx: Ctx, script: string): CmdOut {
  const pkg = readPackageJson(ctx);
  if (!pkg) {
    return {
      err: ["npm error code ENOENT", `npm error path ${ctx.sh.cwd}/package.json`, "npm error enoent Could not read package.json: no such file"],
      code: 254,
    };
  }
  const body = pkg.scripts[script];
  if (!body) {
    return { err: [`npm error Missing script: "${script}"`, "npm error", "npm error To see a list of scripts, run:", "npm error   npm run"], code: 1 };
  }
  const header = ["", `> ${pkg.name}@${pkg.version} ${script}`, `> ${body}`, ""];
  if (script === "test") {
    return {
      out: [
        ...header,
        " FAIL  src/graveyard.test.js",
        "  ● it should not be haunted",
        "",
        "    expect(received).toBe(expected) // Object.is equality",
        "",
        "    Expected: false",
        "    Received: true",
        "",
        "Tests:       1 failed, 12 passed, 13 total",
      ],
      code: 1,
    };
  }
  if (script === "dev" || script === "start") {
    return { out: [...header, "   ▲ Next.js 16.4.3", "   - Local:        http://localhost:3000", "", " ✓ Ready in 666ms"], code: 0 };
  }
  if (script === "build") {
    return {
      out: [...header, "   ▲ Next.js 16.4.3", "", "   Creating an optimized production build ...", " ✓ Compiled successfully in 6.6s", " ✓ Generating static pages (4/4)", "", "Route (app)", "┌ ○ /", "└ ○ /_not-found"],
      code: 0,
    };
  }
  return { out: [...header, `(${script} finished without incident, which is suspicious)`], code: 0 };
}

const npm: Cmd = (ctx, args) => {
  const sub = args[0];
  if (!sub) return ok("npm <command>", "", "Usage: npm install | npm run <script> | npm test | npm start");
  if (sub === "-v" || sub === "--version") return ok("10.9.9");
  if (/^(i|install|ci|add|update|upgrade)$/.test(sub)) {
    const pkgs = args.slice(1).filter((a) => !a.startsWith("-"));
    if (pkgs.length) {
      return ok("", `added ${pkgs.length} package${pkgs.length > 1 ? "s" : ""}, and audited 1338 packages in 2s`, "", "3 vulnerabilities (1 low, 2 moderate)");
    }
    return ok(
      "",
      "added 1337 packages, and audited 1338 packages in 42s",
      "",
      "312 packages are looking for funding",
      "  run `npm fund` for details",
      "",
      "3 vulnerabilities (1 low, 2 moderate)",
      "",
      "To address all issues, run:",
      "  npm audit fix",
    );
  }
  if (sub === "audit") {
    return args.includes("--force")
      ? { out: ["npm warn using --force Recommended protections disabled.", "", "changed 14 packages, and audited 1338 packages in 9s", "", "found 0 vulnerabilities (and 3 new breaking changes)"], code: 0 }
      : { out: ["# npm audit report", "", "3 vulnerabilities (1 low, 2 moderate)"], code: 1 };
  }
  if (sub === "publish") return fail("npm error code E403\nnpm error 403 Forbidden - you do not have permission to publish from the afterlife");
  if (sub === "run" || sub === "run-script") return args[1] ? runScript(ctx, args[1]) : ok("Scripts available: dev, build, test");
  if (sub === "test" || sub === "t") return runScript(ctx, "test");
  if (sub === "start") return runScript(ctx, "start");
  return fail(`npm error Unknown command: "${sub}"`);
};

const npx: Cmd = (_ctx, args) => {
  const pkg = args.find((a) => !a.startsWith("-")) ?? "package";
  return ok(`npm warn exec The following package was not found and will be installed: ${pkg}@1.0.0`, "(simulated: nothing was executed)");
};

const nodeCmd: Cmd = (ctx, args) => {
  if (args[0] === "-v" || args[0] === "--version") return ok("v22.11.0");
  const target = args.find((a) => !a.startsWith("-"));
  if (!target) return ok("Welcome to Node.js v22.11.0.", "(the REPL is not simulated; type exit to leave nothing behind)");
  const abs = resolve(ctx, target);
  const node = getNode(ctx.sh.fs, abs);
  if (!node || node.type !== "file") {
    return { err: ["node:internal/modules/cjs/loader:1228", "  throw err;", "  ^", "", `Error: Cannot find module '${abs}'`, "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)", "", "Node.js v22.11.0"], code: 1 };
  }
  return ok(`(simulated: ${target} ran to completion and was not heard from again)`);
};

const packageManagerAlias = (name: "yarn" | "pnpm" | "bun"): Cmd => (ctx, args) => {
  const sub = args[0];
  if (!sub || /^(i|install|add)$/.test(sub)) return npm(ctx, ["install", ...args.slice(1)]);
  if (sub === "run") return npm(ctx, ["run", ...args.slice(1)]);
  if (name === "bun" && sub === "x") return npx(ctx, args.slice(1));
  return npm(ctx, ["run", sub]);
};

const docker: Cmd = (_ctx, args) => {
  if (args[0] === "ps") return ok("CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES");
  return fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
};

// -------------------------------------------------------------- the haunting

const ghost: Cmd = (_ctx, args) => {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help") {
    return ok(
      "ghost: converse with the thing in your terminal",
      "",
      "  ghost on | off              wake or silence the ghost",
      "  ghost level <whisper|haunt|possess>",
      "  ghost lore                  hear a ghost story about developers",
      "  seance [language]           channel a dead technology",
      "  exorcise [--history]        restore the filesystem and calm the ghost",
    );
  }
  if (sub === "on" || sub === "off") return { out: [sub === "on" ? "The ghost stirs." : "The ghost sleeps. It is still there."], actions: [{ type: "ghost-power", on: sub === "on" }], code: 0 };
  if (sub === "level") {
    const level = args[1] as GhostLevel | undefined;
    if (level !== "whisper" && level !== "haunt" && level !== "possess") return fail("usage: ghost level <whisper|haunt|possess>");
    return { out: [`Intensity set to ${level}.`], actions: [{ type: "ghost-level", level }], code: 0 };
  }
  if (sub === "lore") return { actions: [{ type: "lore" }], code: 0 };
  return fail(`ghost: unknown subcommand '${sub}'. Try: ghost help`);
};

const seance: Cmd = (_ctx, args) => {
  const id = args[0];
  if (!id) {
    return ok(
      "The spirits you may call upon:",
      ...PERSONAS.map((p) => `  seance ${p.id.padEnd(8)} ${p.name} (${p.epitaph})`),
      "",
      "  seance end                  send them back",
    );
  }
  if (id === "end" || id === "off" || id === "stop") return { out: ["The circle is broken. The spirit departs, muttering."], actions: [{ type: "seance", persona: null }], code: 0 };
  const persona = getPersona(id);
  if (!persona) return fail(`seance: no such spirit '${id}'. Run 'seance' to list them.`);
  return { out: [`You light a candle for ${persona.name}...`], actions: [{ type: "seance", persona: persona.id }], code: 0 };
};

const exorcise: Cmd = (_ctx, args) => ({
  out: [
    "Reciting the rites...",
    args.includes("--history") ? "The dead are restored, and your history is forgotten." : "The dead are restored to the way they were. Mostly.",
  ],
  actions: [{ type: "exorcise", history: args.includes("--history") }],
  code: 0,
});

const help: Cmd = () =>
  ok(
    "Echoes of the Terminal: a simulated shell. Nothing here touches your real machine.",
    "",
    "files    ls cd pwd cat head tail grep wc tree mkdir touch rm cp mv chmod",
    "git      status add commit log diff branch checkout push pull reset stash rebase clean",
    "node     node npm npx yarn pnpm (try: npm install, npm test, npm run build)",
    "system   whoami date uname uptime ps env history clear exit man which",
    "haunt    ghost seance exorcise",
    "",
    "Pipes (|), &&, ;, and > redirects work. Tab completes. Up/Down browse history.",
    "Try something you shouldn't: git push --force, rm -rf node_modules, cat .env, sudo rm -rf /",
  );

export const COMMANDS: Record<string, Cmd> = {
  ls, ll: (c, a) => ls(c, ["-l", ...a]), la: (c, a) => ls(c, ["-la", ...a]),
  cd, pwd, cat, echo, mkdir, touch, rm, cp: copyOrMove("cp"), mv: copyOrMove("mv"),
  head, tail, grep, wc, tree, chmod, chown: chmod,
  whoami, id: whoami, hostname, uname, date, uptime, history, env, printenv: env, which, man, ps, top: ps, htop: ps,
  sleep, kill, killall: kill, pkill: kill, clear, exit, logout: exit,
  curl, wget, ping, ssh, scp: ssh,
  vim: editor("vim"), vi: editor("vi"), nvim: editor("nvim"), nano: editor("nano"), emacs: editor("emacs"), code: editor("code"),
  git, npm, npx, node: nodeCmd, yarn: packageManagerAlias("yarn"), pnpm: packageManagerAlias("pnpm"), bun: packageManagerAlias("bun"),
  docker, "docker-compose": docker, podman: docker,
  ghost, seance, exorcise, help,
  true: () => ({ code: 0 }),
  false: () => ({ code: 1 }),
};

export const COMMAND_NAMES = Object.keys(COMMANDS).sort();
