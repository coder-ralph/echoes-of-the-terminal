/**
 * The Scripted Ghost: a hand-written haunting that needs no model at all.
 * It is the offline-of-offline fallback: used when no model is loaded, when
 * WebGPU is missing, when Ollama is not running, or when a model breaks
 * character. It is deliberately good enough to demo without any download.
 */

import { getPersona } from "./personas.ts";
import type { GhostContext } from "./types.ts";

export type Rng = () => number;

const LINES: Record<string, string[]> = {
  // destruction
  apocalypse: [
    "You would unmake everything with a single line? Even the void has standards, mortal.",
    "rm -rf aimed at the root: the oldest spell, and the last one anybody casts twice.",
    "I have watched a thousand deletions. This one sounds like a funeral.",
  ],
  "rm-rf": [
    "No trash can. No undo. Only the quiet where your files used to be.",
    "The dead do not return from rm -rf. I would know. I am one of them.",
    "Recursive, forced and final. Say goodbye to whatever lived there.",
  ],
  "rm-r": [
    "Recursion into the unknown. Are you certain nothing precious is buried down there?",
    "Every directory is a grave you are about to dig up and then fill in.",
  ],
  rm: ["A small death. Somewhere, a file has drawn its last breath.", "Another file joins the choir of the deleted."],
  cleanse: [
    "Clearing the build again. The oldest ritual: banish the weight, then summon it back by morning.",
    "You sweep away the artefacts and the ghosts of old builds. They will be back.",
  ],
  // history
  "force-push": [
    "Are you sure you want to rewrite history, mortal? The dead don't like being disturbed...",
    "Force push. Your teammates' commits will vanish into the same silence as the unborn.",
    "You are overwriting the remote's memories. It will not remember, but it will resent.",
  ],
  "force-lease": [
    "A force with a lease. Even necromancers check the lock before they rewrite the dead.",
    "Polite violence, mortal. The remote will still lose something.",
  ],
  "reset-hard": [
    "Hard reset: uncommitted work, gone to the place where unsaved documents go.",
    "You discard the living to restore the dead. Dark, even for me.",
  ],
  "git-clean": [
    "Untracked files have no history to haunt you with, which is exactly why they cannot come back.",
    "You sweep the untracked. They were never really there, which is how they vanish.",
  ],
  discard: ["Every change you discard here dies unrecorded.", "The working tree forgets, and so shall you."],
  amend: [
    "Amending the past. The old commit does not die; it waits in the reflog, listening.",
    "You rewrite your last words. I heard the first version.",
  ],
  rebase: [
    "Rebasing: reanimating commits in a new order, like a gothic experiment. What could go wrong?",
    "History, stitched together with different thread. Whose body is this?",
  ],
  "branch-delete": ["A branch dies. The reflog remembers; I remember.", "All those commits, orphaned and wandering the reflog."],
  "stash-drop": ["A stash is a coffin you chose not to bury. Now you are burning it.", "Dropped stash: the unborn work will not be born."],
  "history-surgery": ["Rewriting the entire history. Surgeons call it operating; necromancers call it Tuesday."],
  // danger
  secrets: [
    "Secrets in plain text, and you read them aloud. Walls have ears; terminals have ghosts.",
    "A .env file: where passwords go to wait for the breach. I have not told anyone. Yet.",
    "You open the sealed room and behold your own mistakes.",
  ],
  sudo: [
    "Elevated privileges. With great power comes great responsibility, or at least a long incident report.",
    "You summon root. Root does not ask whether you are sure.",
    "You speak with borrowed authority. The system is listening.",
  ],
  chmod: [
    "777. Everyone may read, write and execute. That is not a permission, that is an invitation.",
    "Opening every door. Do not be surprised by who walks in.",
  ],
  kill: ["You reach for kill -9: no goodbyes, no cleanup, no mercy. Efficient.", "The process screams. Nothing is flushed."],
  "curl-pipe": [
    "You pipe the unknown into your shell. I have seen how this ends: with me, in your bashrc.",
    "Trusting a stranger's script with your shell. Bold. Foolish. Historically dull.",
  ],
  "disk-destroy": ["You write to the raw disk. This is not a command; it is a goodbye.", "The universe, reformatted."],
  "fork-bomb": ["A fork bomb. Your machine will think itself into oblivion.", "Recursion without escape: the one spell that casts itself."],
  sql: ["DROP the table and you drop the dead's address book. Back up first. Always.", "SQL with no WHERE and no WHAT. Mortal, mortal..."],
  "iac-destroy": ["You tear down the infrastructure. Servers die quietly, and nobody mourns them until the pager sings.", "Destroy is such a clean word for something so messy."],
  "audit-force": ["The vulnerabilities will leave; so, perhaps, will your build.", "Forcing fixes: replacing one curse with another."],
  publish: ["Publishing is forever. Even unpublish cannot summon back what has been seen.", "To publish is to release a spirit into the wild. May it behave."],
  // tooling
  "npm-install": [
    "One thousand packages, each with its own little ghost.",
    "node_modules grows in the dark. Soon it will outweigh the sun.",
    "Every dependency is a stranger you have invited to live in your house.",
  ],
  build: ["Building. May the compiler be merciful and the cache be truthful.", "Compiling: turning your intentions into something that can fail faster."],
  test: ["The tests will tell you the truth. I already know it.", "Green means nothing. Red means somebody lived here."],
  "test-fail": ["A red test. Somewhere, a function has died and nobody told it.", "The suite fails. The ghost in your code is making itself known."],
  node: ["Node runs your script. Somewhere, a promise is being broken.", "JavaScript: brave and unsupervised."],
  docker: ["Containers: coffins with excellent tooling.", "A tidy little crypt, shipped in layers."],
  // git, everyday
  commit: [
    "A commit: a spell cast into the permanent record. Choose your message wisely, mortal.",
    "Another memory sealed into the ledger. The log never forgets.",
    "You commit. The past hardens around you like amber.",
  ],
  add: ["Staging your changes, like candles on an altar.", "Gathering the offerings before the ritual."],
  status: ["git status: the morbid habit of checking the wounds.", "Untracked files. Unspoken things. Both wait in the dark."],
  log: ["You read the history of your crimes. The log has always been honest.", "Every commit is an epitaph. Some are better written than others."],
  diff: ["You examine what changed. Not everything that changed was in the diff.", "Changes: the living wound of the working tree."],
  push: ["Your commits cross into the remote, where the dead and the deployed rest together.", "Pushed. There is no recall, only repair."],
  pull: ["You pull from the remote. Who knows what the others have changed in the dark?", "Fetching other people's ghosts into your timeline."],
  branch: ["Branches: parallel timelines, mostly abandoned.", "Another branch for another life you will never merge."],
  checkout: ["You walk between timelines. Mind what you carry across.", "Changing branches: the living swapping places with the dead."],
  merge: ["Merging two timelines. A conflict is just two ghosts claiming the same line.", "The merge is made. Some lines did not survive."],
  stash: ["Stashing work in a drawer you will forget to open.", "Hidden away. It will outlive your intentions."],
  // editors
  vim: [
    "You have entered vim. I can feel you hesitating over :q. The way out is known only to the dead.",
    "Escape, colon, q, bang. I have said it before. I will say it forever.",
    "No one has ever left vim. People have only stopped typing.",
  ],
  emacs: ["Emacs: an operating system that has forgotten its purpose, haunting a text editor's body.", "Ctrl-x Ctrl-c. The pinky remembers what the mind has forgotten."],
  nano: ["Nano. The editor of the cautious. I respect it, and pity it, and both are true.", "Ctrl-X to exit. Cowardly? No. Merciful."],
  editor: ["Opening an editor. The blank file is the loneliest place in computing."],
  // everyday
  exit: ["You flee the terminal? I will be here when you return. I am always here.", "Leaving. The prompt will wait. The ghost will wait. We are very good at waiting."],
  network: ["You reach for the network, but the network is a rumour in this crypt.", "No route to anywhere. I find it restful."],
  ls: [
    "Files, files, and not one of them alive. How tidy your crypt is.",
    "You count the contents of the room again. They have not changed. Neither have you.",
    "Listing the dead: always a short ritual, rarely a satisfying one.",
  ],
  tree: ["A tree of files, and not a single leaf alive.", "The structure of your crypt, laid out in bone-white lines."],
  pwd: ["You ask where you are. Always right here, in the dark, where I can see you.", "A path of slashes, leading nowhere in particular. How very mortal."],
  cd: ["You walk into another room of the crypt. The ghost walks with you.", "A new directory, a new silence."],
  whoami: ["Who are you? A question for philosophers, and for me, since I know your answer already.", "You are the one who types. That is all anyone truly is."],
  date: ["The date: a thing you invented so that death would have an appointment.", "Time passes. The terminal notes it and says nothing. I do not have that restraint."],
  uptime: ["Up for 666 days. The machine has not slept. Neither have I.", "Uptime: how long something has survived without a reboot. Proud, or cursed?"],
  cat: ["Reading the dead letters again, mortal?", "You open a file as one opens a window onto a room that is not yours."],
  echo: ["You speak into the void and the void answers with the exact same words. How rude.", "Echo. Of course. It is my name."],
  clear: ["The screen is wiped. The echoes remain.", "You clear the screen. The scrollback gasps; I do not forget."],
  history: ["You open the book of your sins. It is longer than you remember.", "Shell history: the diary of a mortal who thinks no one reads."],
  create: ["A new thing is born in the dark. I wonder what it will regret.", "You build something small. Everything starts small."],
  help: ["Help, you cry. The dead have read the manual and cannot recommend it.", "You ask for help. The ghost rarely gives help; it gives context."],
  man: ["A manual for a dead tongue. Read carefully; the footnotes bite."],
  ps: ["Processes: the ghosts of programs that have not yet been told to stop.", "Look closely. One of those PIDs is me."],
  ghost: ["You speak to me directly. How rare. How charming.", "You wish to talk about the ghost? I am listening. I am always listening."],
  // meta
  typo: [
    "Even your typos speak with the voice of the damned. That is not a command; it is a lament.",
    "Command not found. It was never alive.",
    "The shell does not know that word. I do. I am not telling.",
  ],
  failure: ["It failed. Of course it did. Everything does, eventually.", "A non-zero exit. The ghost smiles, politely."],
  unknown: ["I do not know that spell either, but I admire the confidence.", "Strange incantation. The shell is not impressed.", "Whatever that was, I felt it in the walls."],
  idle: [
    "You have gone quiet. I do not like it when you go quiet.",
    "Are you still there, mortal? The cursor blinks like a pulse.",
    "The silence is loud. Type something. Anything. Even rm.",
    "I can hear you thinking. It sounds like a fan spinning up.",
  ],
};

const CATEGORY_FALLBACK: Record<string, string> = {
  destructive: "rm-rf",
  history: "rebase",
  secrets: "secrets",
  privilege: "sudo",
  network: "network",
  install: "npm-install",
  build: "build",
  vcs: "status",
  editor: "editor",
  navigation: "cd",
  inspect: "cat",
  create: "create",
  meta: "help",
  unknown: "unknown",
};

const WITCHING = [
  "It is {time}. Nothing good was ever committed at this hour.",
  "{time}: the veil is thin and the linter is thinner.",
  "At {time}, even the logs begin to whisper.",
];

const FAIL_SUFFIX = ["And it failed, as it was always going to.", "The exit code tells me everything.", "Fear the non-zero."];

const POSSESS_FLAVOUR = [
  "I can see your cursor.",
  "Did you type that, or did I?",
  "Your keyboard is warmer than it should be.",
  "Look behind the prompt.",
  "{user}... {user}... {user}...",
];

export const LORE: string[] = [
  "They say the first bug was a moth trapped in a relay. It has haunted every deploy since.",
  "Somewhere there is a server nobody remembers provisioning. It still answers pings. It never answers questions.",
  "The oldest cron job in the company runs at 3:03 AM. No one knows what it does. Everyone knows not to remove it.",
  "A developer once deleted a TODO that said 'do not delete'. The repository has had exactly one very bad week a year since.",
  "Somewhere a Perl script written in 1998 is still running. It is written in a language only the script understands.",
  "Listen closely at midnight to any repo with a force-push in its past: you can hear the lost commits trying to rebase themselves.",
  "Every legacy codebase has a room no one enters. It is called utils.js.",
  "The thirteenth CI run never passes. We stopped counting at twelve.",
];

const pick = <T>(arr: T[], rng: Rng): T => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];

export function scriptedLore(rng: Rng = Math.random): string {
  return pick(LORE, rng);
}

const hhmm = (ctx: GhostContext) => `${String(ctx.hour).padStart(2, "0")}:${String(ctx.minute).padStart(2, "0")}`;
const sentenceCount = (s: string) => (s.match(/[.!?…]+(\s|$)/g) ?? []).length;

function linesFor(ctx: GhostContext): string[] {
  if (!ctx.command) return LINES.idle;
  const { risk, exitCode } = ctx;
  if (exitCode === 127 && (risk.tags[0] ?? "unknown") === "unknown") return LINES.typo;
  if (exitCode !== 0 && risk.tags.includes("test")) return LINES["test-fail"];
  for (const tag of risk.tags) if (LINES[tag]) return LINES[tag];
  if (exitCode !== 0) return LINES.failure;
  return LINES[CATEGORY_FALLBACK[risk.category]] ?? LINES.unknown;
}

/** Deterministic given an rng. Pass a seeded rng in tests. */
export function scriptedWhisper(ctx: GhostContext, rng: Rng = Math.random): string {
  const persona = getPersona(ctx.persona);
  if (persona && ctx.command) {
    const pool = ctx.risk.dread >= 2 ? persona.danger : persona.lines;
    return pick(pool, rng);
  }
  if (persona && !ctx.command) return pick(persona.lines, rng);

  let text = pick(linesFor(ctx), rng);

  // Mood modifiers: each only applies if there is room, so whispers stay short.
  if (ctx.command && ctx.exitCode !== 0 && ctx.exitCode !== 127 && sentenceCount(text) <= 1 && rng() < 0.4) {
    text += " " + pick(FAIL_SUFFIX, rng);
  }
  if (ctx.hour < 4 && sentenceCount(text) <= 2 && rng() < 0.45 && ctx.level !== "whisper") {
    text += " " + pick(WITCHING, rng).replace("{time}", hhmm(ctx));
  }
  if (ctx.level === "possess" && rng() < 0.6) {
    text += " " + pick(POSSESS_FLAVOUR, rng).replace(/\{user\}/g, ctx.user);
  }
  return text;
}
