/**
 * Commands the sandbox lacks, added to `.sparkbox/bin` (first on the PATH)
 * every time the runtime boots. Most are small Node programs in
 * `guest/tools/`; each gets a bash wrapper, since the runtime runs bash
 * scripts from the PATH but not Node files with a shebang. The rest are
 * short bash scripts.
 */
import { gitBridgePort } from "./git-bridge-script.ts";

/**
 * Printed by the terminal's bash before every prompt (and, with `open;PATH`,
 * by the edit command): an operating system command the page's terminal
 * intercepts.
 */
export const terminalPromptCode = 7700;

const sources = import.meta.glob<string>("./guest/tools/*.{mjs,cjs}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const toolsDirectory = ".sparkbox/tools";
const binDirectory = ".sparkbox/bin";

/** Command name → the Node program that implements it. */
const nodeCommands: Record<string, string> = {
  find: "find",
  xargs: "xargs",
  diff: "diff",
  tree: "tree",
  du: "du",
  less: "less",
  more: "less",
  curl: "curl",
  wget: "wget",
};

const bashCommands: Record<string, string> = {
  clear: `printf '\\033[H\\033[2J\\033[3J'\n`,
  reset: `printf '\\033c'\n`,
  which: `# The path of each command bash would run, like which(1).
all=0 status=0
for arg; do
  case $arg in
    -a) all=1 ;;
    -*) ;;
    *)
      if [ $all = 1 ]; then found=$(type -aP -- "$arg"); else found=$(type -P -- "$arg"); fi
      if [ -n "$found" ]; then echo "$found"; else status=1; fi ;;
  esac
done
exit $status
`,
  // In bash: when Node kills a child process this runtime aborts noisily,
  // while bash's kill is clean. The command keeps the terminal's stdin.
  timeout: `signal=TERM preserve=0
while [ $# -gt 0 ]; do
  case $1 in
    -s|--signal) signal=$2; shift 2 ;;
    --signal=*) signal=\${1#*=}; shift ;;
    -k|--kill-after) shift 2 ;;
    --kill-after=*|--foreground|-v|--verbose) shift ;;
    --preserve-status) preserve=1; shift ;;
    --) shift; break ;;
    -*) echo "timeout: invalid option -- '$1'" >&2; exit 125 ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || { echo "usage: timeout DURATION COMMAND [ARG]..." >&2; exit 125; }
duration=$1; shift
[[ $duration =~ ^[0-9]+(\\.[0-9]+)?[smhd]?$ ]] || { echo "timeout: invalid time interval '$duration'" >&2; exit 125; }
marker=$(mktemp)
rm -f "$marker"
"$@" <&0 &
child=$!
# The watcher takes its sleep down with it, so no sleep outlives the command.
(
  trap 'kill $sleeper 2>/dev/null; exit 0' TERM
  sleep "$duration" &
  sleeper=$!
  wait $sleeper && : > "$marker" && kill -s "$signal" "$child"
) >/dev/null 2>&1 &
watcher=$!
wait "$child"
status=$?
kill "$watcher" 2>/dev/null
if [ -e "$marker" ]; then
  rm -f "$marker"
  [ $preserve = 1 ] && exit $status
  exit 124
fi
exit $status
`,
  // Permissions are not enforced here: every file is readable, writable and
  // executable. Scripts still call chmod, so check the files and succeed.
  chmod: `status=0 mode=
for arg; do
  case $arg in
    -R|-f|-v|-c|--recursive|--quiet|--silent|--verbose|--changes) ;;
    *) if [ -z "$mode" ]; then mode=$arg
       elif [ ! -e "$arg" ]; then echo "chmod: cannot access '$arg': No such file or directory" >&2; status=1; fi ;;
  esac
done
[ -n "$mode" ] || { echo "chmod: missing operand" >&2; exit 1; }
exit $status
`,
  npx: `# A package's own command when it is installed, otherwise pnpm dlx.
while [ "$1" = --yes ] || [ "$1" = -y ] || [ "$1" = --no-install ]; do shift; done
[ $# -gt 0 ] || { echo "usage: npx COMMAND [ARGS...]" >&2; exit 1; }
dir=$PWD
while :; do
  [ -e "$dir/node_modules/.bin/$1" ] && exec "$dir/node_modules/.bin/$1" "\${@:2}"
  [ "$dir" = / ] && break
  dir=$(dirname "$dir")
done
exec pnpm dlx "$@"
`,
  tsx: `# The page bundles the file, since this Node cannot strip TypeScript types.
bundle=$(node /workspace/${toolsDirectory}/tsx.mjs "$@") || exit $?
exec node "$bundle" "\${@:2}"
`,
  // Opens a file in Sparkbox's editor: the Terminal reads this escape
  // sequence and switches to the Files view.
  edit: `name=$(basename "$0")
[ -t 1 ] && [ -n "$SPARKBOX_TERMINAL" ] || { echo "$name: opens a file in the Sparkbox editor, from the Terminal only" >&2; exit 1; }
file=
for arg; do case $arg in -*|+*) ;; *) file=$arg ;; esac; done
[ -n "$file" ] || { echo "usage: $name FILE" >&2; exit 1; }
path=$(realpath -m -- "$file")
case $path in /workspace/*) ;; *) echo "$name: $file is outside the project" >&2; exit 1 ;; esac
[ -d "$path" ] && { echo "$name: $file is a directory" >&2; exit 1; }
[ -e "$path" ] || { mkdir -p "$(dirname "$path")" && : > "$path"; } || exit 1
printf '\\033]${terminalPromptCode};open;%s\\007' "\${path#/workspace/}"
`,
};
for (const alias of ["code", "vi", "vim", "nano"])
  bashCommands[alias] = bashCommands.edit as string;
bashCommands["ts-node"] = bashCommands.tsx as string;

/** Files to add to the sandbox at boot, by workspace-relative path. */
export function guestToolFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, source] of Object.entries(sources)) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    files[`${toolsDirectory}/${name}`] = source.replace("__BRIDGE_PORT__", String(gitBridgePort));
  }
  for (const [command, program] of Object.entries(nodeCommands))
    files[`${binDirectory}/${command}`] =
      `#!/bin/bash\nexec node /workspace/${toolsDirectory}/${program}.mjs "$@"\n`;
  for (const [command, script] of Object.entries(bashCommands))
    files[`${binDirectory}/${command}`] = `#!/bin/bash\n${script}`;
  return files;
}

/** The commands added, for the agent's prompt and the docs. */
export const guestCommands = [...Object.keys(nodeCommands), ...Object.keys(bashCommands)].sort();
