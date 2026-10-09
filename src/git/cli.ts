/**
 * The `git` command the agent runs in the sandbox, answered here in the
 * page. A subset of git's porcelain with git-like output: enough for
 * status, add, commit, log, diff, branches, merge, push and pull. Anything
 * else says so plainly rather than pretending.
 */
import type { Changes } from "../workspace/types.ts";
import { describeGitError, GitError, type Repository } from "./repo.ts";

export type CliResult = { stdout: string; stderr: string; code: number };

const supported = [
  "status",
  "add",
  "rm",
  "commit",
  "log",
  "diff",
  "show",
  "branch",
  "checkout",
  "switch",
  "restore",
  "reset",
  "merge",
  "remote",
  "fetch",
  "pull",
  "push",
  "tag",
  "rev-parse",
  "config",
  "init",
];

function parse(argv: string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  /** Index into positional where `--` was given: everything after it is a path. */
  let dashes: number | null = null;
  let afterDashes = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (afterDashes || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashes = true;
      dashes = positional.length;
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals > 0) values.set(arg.slice(2, equals), arg.slice(equals + 1));
      else flags.add(arg.slice(2));
      continue;
    }
    // Short flags: -am "msg", -n 5, -b name, -m msg
    const letters = arg.slice(1);
    for (const letter of letters) flags.add(letter);
    if (/[mnb]$/.test(letters) || /^\d+$/.test(letters)) {
      if (/^\d+$/.test(letters)) {
        values.set("n", letters);
        flags.delete(letters);
      } else {
        const next = argv[i + 1];
        if (next !== undefined) {
          values.set(letters.slice(-1), next);
          i++;
        }
      }
    }
  }
  return { flags, values, positional, dashes };
}

function shortSha(sha: string) {
  return sha.slice(0, 7);
}

function ok(stdout = ""): CliResult {
  return { stdout, stderr: "", code: 0 };
}

function fail(message: string, code = 1): CliResult {
  return { stdout: "", stderr: `${message}\n`, code };
}

function fatal(message: string): CliResult {
  return fail(`fatal: ${message}`, 128);
}

function renderDiff(changes: Changes) {
  return changes.files
    .map((file) =>
      file.binary
        ? `diff --git a/${file.path} b/${file.path}\nBinary files differ\n`
        : `diff --git a/${file.path} b/${file.path}\n${file.diff.replace(/^(Index: .*\n)?=+\n/, "")}`,
    )
    .join("");
}

export async function runGitCommand(repo: Repository, argv: string[]): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help")
    return ok(
      `usage: git <command> [<args>]\n\nSupported here: ${supported.join(", ")}.\nThe repository is kept by Sparkbox; push and pull go to the GitHub repository the project is backed up to.\n`,
    );
  if (command === "--version") return ok("git version 2.0.0 (Sparkbox, isomorphic-git)\n");
  const { flags, values, positional, dashes } = parse(rest);
  try {
    if (!repo.initialized() && command !== "init") await repo.ensure();
    switch (command) {
      case "init":
        return ok(
          (await repo.ensure())
            ? "Initialized empty Git repository\n"
            : "Reinitialized existing Git repository\n",
        );
      case "status": {
        const branch = await repo.currentBranch();
        const rows = await repo.matrix();
        const short = flags.has("s") || flags.has("short") || flags.has("porcelain");
        const lines: string[] = [];
        const staged: string[] = [];
        const unstaged: string[] = [];
        const untracked: string[] = [];
        for (const [path, head, workdir, stage] of rows) {
          if (head === 1 && workdir === 1 && stage === 1) continue;
          const x =
            head === 0 && stage >= 2
              ? "A"
              : stage === 0 && head === 1
                ? "D"
                : head === 1 && stage === 2
                  ? "M"
                  : " ";
          const y = workdir === 0 && stage !== 0 ? "D" : workdir === 2 && stage !== 2 ? "M" : " ";
          if (head === 0 && stage === 0) {
            untracked.push(path);
            lines.push(`?? ${path}`);
            continue;
          }
          lines.push(`${x}${y} ${path}`);
          if (x !== " ")
            staged.push(
              `${x === "A" ? "new file" : x === "D" ? "deleted" : "modified"}:   ${path}`,
            );
          if (y !== " ") unstaged.push(`${y === "D" ? "deleted" : "modified"}:   ${path}`);
        }
        if (short) return ok(lines.length ? `${lines.join("\n")}\n` : "");
        let out = `On branch ${branch}\n`;
        if (staged.length)
          out += `Changes to be committed:\n${staged.map((l) => `\t${l}`).join("\n")}\n\n`;
        if (unstaged.length)
          out += `Changes not staged for commit:\n${unstaged.map((l) => `\t${l}`).join("\n")}\n\n`;
        if (untracked.length)
          out += `Untracked files:\n${untracked.map((l) => `\t${l}`).join("\n")}\n\n`;
        if (!staged.length && !unstaged.length && !untracked.length)
          out += "nothing to commit, working tree clean\n";
        return ok(out);
      }
      case "add": {
        const paths =
          flags.has("A") || flags.has("all") || !positional.length ? undefined : positional;
        if (!paths && !flags.has("A") && !flags.has("all"))
          return fatal("Nothing specified, nothing added. Use git add -A or name files.");
        await repo.addAll(paths);
        return ok();
      }
      case "rm": {
        if (!positional.length) return fatal("no files given");
        for (const path of positional) {
          if (!flags.has("cached")) {
            const entry = await repo.worktree.stat(path);
            if (entry) await repo.worktree.deleteFile(path);
          }
        }
        await repo.addAll(positional);
        return ok(`${positional.map((path) => `rm '${path}'`).join("\n")}\n`);
      }
      case "commit": {
        const message = values.get("m") ?? values.get("message");
        if (!message) return fatal('a commit message is required: git commit -m "..."');
        if (flags.has("a") || flags.has("all")) await repo.addAll();
        if (!(await repo.staged()))
          return fail(
            'nothing to commit (use "git add -A" or "git commit -am" to include changes)',
          );
        const sha = await repo.commit(message);
        const branch = await repo.currentBranch();
        return ok(`[${branch} ${shortSha(sha)}] ${message.split("\n")[0]}\n`);
      }
      case "log": {
        const depth = Number(values.get("n") ?? values.get("max-count") ?? 20) || 20;
        const entries = await repo.log(depth, positional[0] ?? "HEAD");
        if (!entries.length) return fatal("your current branch does not have any commits yet");
        if (flags.has("oneline"))
          return ok(
            `${entries.map((e) => `${shortSha(e.sha)} ${e.message.split("\n")[0]}`).join("\n")}\n`,
          );
        return ok(
          entries
            .map(
              (e) =>
                `commit ${e.sha}\nAuthor: ${e.author}\nDate:   ${e.date.toISOString()}\n\n    ${e.message.trim().split("\n").join("\n    ")}\n`,
            )
            .join("\n"),
        );
      }
      case "diff": {
        const staged = flags.has("staged") || flags.has("cached");
        // Like git: arguments that name commits are refs (a..b names both), the rest are paths.
        const refs: string[] = [];
        const paths = dashes === null ? [] : positional.slice(dashes);
        for (const arg of dashes === null ? positional : positional.slice(0, dashes)) {
          const range = /^(.*?)\.\.\.?(.*)$/.exec(arg);
          const ends = range ? [range[1] || "HEAD", range[2] || "HEAD"] : [arg];
          const oids = await Promise.all(ends.map((end) => repo.resolve(end)));
          if (oids.every((oid): oid is string => Boolean(oid))) refs.push(...oids);
          else paths.push(arg);
        }
        let changes: Changes;
        if (staged) changes = await repo.diff("HEAD", "STAGE", paths.length ? paths : undefined);
        else if (refs.length >= 2)
          changes = await repo.diff(
            refs[0] ?? "HEAD",
            refs[1] ?? "HEAD",
            paths.length ? paths : undefined,
          );
        else if (refs.length === 1)
          changes = await repo.diff(refs[0] ?? "HEAD", "WORKDIR", paths.length ? paths : undefined);
        else changes = await repo.diff("STAGE", "WORKDIR", paths.length ? paths : undefined);
        if (flags.has("stat") || flags.has("name-only"))
          return ok(
            changes.files
              .map((f) => (flags.has("name-only") ? f.path : ` ${f.path} | ${f.status}`))
              .join("\n") + (changes.files.length ? "\n" : ""),
          );
        return ok(renderDiff(changes));
      }
      case "show": {
        const ref = positional[0] ?? "HEAD";
        const oid = await repo.resolve(ref);
        const entry = oid && (await repo.show(oid));
        if (!oid || !entry) return fatal(`bad revision '${ref}'`);
        const parent = await repo.parentOf(oid);
        const diff = parent
          ? renderDiff(await repo.diff(parent, oid))
          : renderDiff(await repo.diff("4b825dc642cb6eb9a060e54bf8d69288fbee4904", oid)).replace(
              /4b825dc6\w*/g,
              "root",
            );
        return ok(
          `commit ${entry.sha}\nAuthor: ${entry.author}\nDate:   ${entry.date.toISOString()}\n\n    ${entry.message.trim()}\n\n${diff}`,
        );
      }
      case "branch": {
        if (flags.has("d") || flags.has("D") || flags.has("delete")) {
          const name = positional[0];
          if (!name) return fatal("branch name required");
          await repo.deleteBranch(name);
          return ok(`Deleted branch ${name}.\n`);
        }
        if (positional[0]) {
          await repo.createBranch(positional[0]);
          return ok();
        }
        const current = await repo.currentBranch();
        const branches = await repo.branches();
        return ok(`${branches.map((b) => `${b === current ? "* " : "  "}${b}`).join("\n")}\n`);
      }
      case "checkout":
      case "switch": {
        const create =
          values.get("b") ?? values.get("c") ?? (flags.has("c") ? positional.shift() : undefined);
        if (create) {
          await repo.createBranch(create, true);
          return ok(`Switched to a new branch '${create}'\n`);
        }
        const target = positional[0];
        if (!target) return fatal("a branch name or file path is required");
        const paths = positional.slice(1);
        if (paths.length || (await repo.worktree.stat(target))) {
          // git checkout -- <paths>: restore files from the index/HEAD.
          const files = paths.length ? paths : [target];
          await repo.checkout("HEAD", { force: true, paths: files });
          return ok(`Updated ${files.length} path${files.length === 1 ? "" : "s"} from HEAD\n`);
        }
        await repo.checkout(target, { force: flags.has("f") || flags.has("force") });
        return ok(`Switched to branch '${target}'\n`);
      }
      case "restore": {
        if (!positional.length) return fatal("you must specify path(s) to restore");
        if (flags.has("staged")) {
          await repo.unstage(positional);
          return ok();
        }
        await repo.checkout("HEAD", { force: true, paths: positional });
        return ok();
      }
      case "reset": {
        if (flags.has("hard")) {
          const ref = positional[0] ?? "HEAD";
          const branch = await repo.currentBranch();
          if (ref !== "HEAD" && ref !== branch)
            return fatal(
              "reset --hard to another commit is not available here. Use git checkout <branch>, or git restore <paths> to discard edits.",
            );
          // Re-checking out the branch itself keeps HEAD attached to it.
          await repo.checkout(branch, { force: true });
          const head = await repo.head();
          return ok(`HEAD is now at ${head ? shortSha(head) : "?"}\n`);
        }
        await repo.unstage(positional.length ? positional : undefined);
        return ok();
      }
      case "merge": {
        const theirs = positional[0];
        if (!theirs) return fatal("a branch to merge is required");
        const result = await repo.merge(theirs);
        if (result.alreadyMerged) return ok("Already up to date.\n");
        return ok(
          result.fastForward
            ? `Fast-forward to ${shortSha(result.sha)}\n`
            : `Merge made by the 'recursive' strategy. ${shortSha(result.sha)}\n`,
        );
      }
      case "remote": {
        const sub = positional[0];
        if (sub === "add" || sub === "set-url") {
          const url = positional[2];
          if (!url) return fatal("usage: git remote add origin <url>");
          await repo.setRemote(url);
          return ok();
        }
        const url = await repo.remote();
        if (!url) return ok();
        return ok(
          flags.has("v") || flags.has("verbose")
            ? `origin\t${url} (fetch)\norigin\t${url} (push)\n`
            : "origin\n",
        );
      }
      case "fetch":
        if ((await repo.currentBranch()) === "(detached)")
          return fatal("HEAD is detached. Run git checkout main first.");
        await repo.fetch();
        return ok();
      case "pull": {
        if ((await repo.currentBranch()) === "(detached)")
          return fatal("HEAD is detached. Run git checkout main first.");
        await repo.pull();
        const head = await repo.head();
        return ok(`Already up to date or merged. HEAD is now at ${head ? shortSha(head) : "?"}\n`);
      }
      case "push": {
        if (!(await repo.remote()))
          return fatal(
            'no remote: ask the user to click "Back up to GitHub" in the header, which creates the repository and sets origin.',
          );
        if (flags.has("f") || flags.has("force") || flags.has("force-with-lease"))
          return fatal(
            "force pushes are not available here: they would discard commits on GitHub. Run git pull (which merges), resolve anything it reports, then git push.",
          );
        if ((await repo.currentBranch()) === "(detached)")
          return fatal("HEAD is detached. Run git checkout main first.");
        await repo.push();
        const branch = await repo.currentBranch();
        return ok(`Pushed ${branch} to origin.\n`);
      }
      case "tag": {
        if (positional[0]) {
          await repo.tag(positional[0]);
          return ok();
        }
        return ok(`${(await repo.tags()).join("\n")}\n`);
      }
      case "rev-parse": {
        if (flags.has("abbrev-ref")) return ok(`${await repo.currentBranch()}\n`);
        const head = await repo.head();
        if (!head) return fatal("no commits yet");
        return ok(`${flags.has("short") ? shortSha(head) : head}\n`);
      }
      case "config":
        // Identity and settings are managed by Sparkbox; accept and ignore.
        return ok();
      case "stash":
        return fatal(
          'stash is not available here. Commit your work instead (git add -A && git commit -m "wip"), then reset or revert later.',
        );
      case "rebase":
        return fatal("rebase is not available here. Use git merge instead.");
      default:
        return fatal(
          `'${command}' is not a git command Sparkbox supports. Available: ${supported.join(", ")}.`,
        );
    }
  } catch (error) {
    if (error instanceof GitError) return fatal(error.message);
    return fatal(describeGitError(error));
  }
}
