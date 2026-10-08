/**
 * Files for a new project: only the brief. The agent scaffolds the stack on
 * its first turn, so nothing here competes with it or shows up as an edit
 * nobody asked for.
 */
export function starterTemplate(name: string): Record<string, string> {
  return {
    "PROJECT.md": `# ${name}\n\nDescribe what this app should do. The agent reads this file first.\n`,
  };
}
