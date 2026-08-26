# Contributing to OmniShell

## Before opening a change

- Keep tool installers local to their own <code>system/&lt;Tool&gt;</code> directory.
- Do not add global PATH fallbacks.
- Use an official vendor URL, npm package, or GitHub release.
- Never commit runtime profiles, tokens, downloads, or installer logs.
- Preserve the minimal interface and keyboard workflow.

## Development

~~~powershell
cd app
npm ci
npm run check
~~~

For installer or PTY work, install the affected CLI locally and run:

~~~powershell
npm run health
~~~

## Pull requests

Describe the behavior change, the failure mode it addresses, and the commands used to verify it. Include a screenshot for visible UI changes.

Use focused conventional commits such as:

- <code>feat: add a verified CLI installer</code>
- <code>fix: preserve terminal colors after resize</code>
- <code>docs: clarify profile isolation</code>
