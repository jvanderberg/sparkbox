/** Files for a new project. No install step is needed to preview it. */
export function starterTemplate(name: string): Record<string, string> {
  return {
    "PROJECT.md": `# ${name}\n\nDescribe what this app should do. The agent reads this file first.\n`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main>
      <h1>${name}</h1>
      <p>Edit this page with the agent, or in the editor.</p>
      <button id="count" type="button">Clicked 0 times</button>
    </main>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`,
    "styles.css": `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}
body {
  margin: 0;
  display: grid;
  place-items: center;
  min-height: 100vh;
}
main {
  text-align: center;
  padding: 2rem;
}
button {
  font: inherit;
  padding: 0.6rem 1.2rem;
  border-radius: 999px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
`,
    "app.js": `const button = document.querySelector("#count");
let clicks = 0;
button.addEventListener("click", () => {
  clicks += 1;
  button.textContent = \`Clicked \${clicks} times\`;
});
`,
  };
}
