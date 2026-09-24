<p align="center">
  <img src="docs/images/omnishell-banner.png" width="100%" alt="OmniShell — AI coding tools in one Windows terminal">
</p>

<p align="center">
  <a href="https://github.com/Utku4836/OmniShell/releases/latest">Download for Windows</a> &nbsp; · &nbsp;
  <a href="#supported-tools">Supported tools</a> &nbsp; · &nbsp;
  <a href="#development">Build from source</a> &nbsp; · &nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

OmniShell is an open-source Windows desktop app for running AI coding CLIs. Choose a tool, create a profile, and sign in inside its terminal. You can keep personal and work accounts in separate profiles and switch between them from one interface.

The home screen places a focused vertical tool list on the left and keeps the ASCII wordmark on the right. The selected CLI appears at full size, its neighbors remain close, and distant entries recede without leaving the keyboard flow. Each tool has one CLI installation; its profiles have separate credentials, configuration, and workspaces. Terminal sessions use Windows ConPTY and xterm.js, with support for keyboard navigation, text selection, and clipboard shortcuts.

## Get started

Download **OmniShell.exe** from the [latest release](https://github.com/Utku4836/OmniShell/releases/latest). Run the portable executable, select a CLI, and confirm its installation. Then open a profile and sign in with the tool's own authentication flow.

You need Windows 10 or 11. CLI subscriptions and API access are separate from OmniShell.

The portable package is around 300–400 MB. It uses store compression to reduce the extraction work at startup. Release binaries are unsigned, so Windows SmartScreen may ask you to confirm the first launch.

![OmniShell home screen with the supported coding tools](docs/images/omnishell-overview.png)

## Profiles

Create a named profile for each account or workspace you want to keep separate. Profiles of the same tool use one CLI installation and version. Each profile folder uses its name and moves when you rename it. Delete a custom profile by confirming a move to recoverable trash.

In **Settings**, you can choose:

| Setting | Behavior |
|---|---|
| **Full Permission** | Start the CLI with its unattended or approval-bypass option. Off by default. |
| **Shared Sessions** | Exchange session data with other opted-in profiles of the same CLI. |
| **Shared Models** | Exchange the tool's supported model metadata or cache. |
| **Shared Config** | Exchange the tool's supported configuration files. |

![Example Personal and Work profiles, with launch and sharing settings](docs/images/omnishell-profiles.png)

Sharing stays within one CLI family. A Codex profile can share with another Codex profile; it cannot share with Claude Code. Close a profile before opening another that uses the same shared category. Independent profiles can run at the same time.

OmniShell excludes dedicated authentication files from sharing. Some tools store API keys inside general configuration files, so enable Shared Config only when you intend to share those settings. Turning sharing off keeps the profile's current local copy.

**Full Permission bypasses the selected CLI's approval prompts.** Enable it only for profiles and workspaces you trust. Profile separation organizes local data; it is not an operating-system security sandbox. CLIs still run with your Windows account permissions.

## Supported tools

| Tool | Installation source |
|---|---|
| [Claude Code](https://github.com/anthropics/claude-code) | `@anthropic-ai/claude-code` |
| [Codex](https://github.com/openai/codex) | `@openai/codex` |
| [OpenCode](https://github.com/anomalyco/opencode) | `opencode-ai` |
| [Antigravity CLI](https://antigravity.google/docs/cli-install) | Official Windows release with checksum verification |
| [Aider](https://aider.chat/docs/install.html) | Official PowerShell installer |
| [GitHub Copilot CLI](https://github.com/github/copilot-cli) | `@github/copilot` |
| [Cursor Agent](https://prod.cursor.com/docs/cli/installation) | Official Windows release |
| [Amp](https://ampcode.com/) | `@ampcode/cli` |
| [Goose](https://github.com/aaif-goose/goose) | Official Windows release |
| [Crush](https://github.com/charmbracelet/crush) | `@charmland/crush` |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | `@qwen-code/qwen-code` |
| [Kimi Code](https://github.com/MoonshotAI/kimi-cli) | `@moonshot-ai/kimi-code` |

OmniShell resolves commands from the tool's own directory. Installers report progress in the interface and keep a local transcript for troubleshooting. An installation is marked ready only after OmniShell finds its expected executable. Updates wait until all profiles of that tool are closed.

## Keyboard and window controls

| Input | Action |
|---|---|
| Arrow keys or `J` / `K` | Navigate the tool grid |
| `Enter` | Confirm a choice or open the selected profile |
| `N` / `R` in the profile picker | Create or rename a profile |
| `S` in the profile picker | Open profile settings |
| `I` in the profile picker | Install or update the CLI shared by this tool's profiles |
| `U` in the tool grid | Update or reinstall the selected CLI |
| `Ctrl+C` with selected text | Copy the selection |
| `Ctrl+V` or `Ctrl+Shift+V` | Paste into the terminal |
| Right-click | Open window and session actions |
| `Ctrl+Alt+S` | Hide or restore OmniShell |

**Switch CLI** keeps your current session open and launches the selected profile in a new window. Selecting an already running profile brings its window forward. When a CLI exits, every window keeps a visible session-ended message; press `Enter` to restart or close the window from its context menu. Use **Minimize** to send a window to the taskbar. `Esc` stays with the active CLI.

## Local storage

Source builds use the repository's `system/` directory. Packaged builds use `%APPDATA%\OmniShell\system`, unless you set `OMNISHELL_SYSTEM_ROOT`.

```text
system/
├── _profiles/
│   ├── profiles.json          Profile names and settings
│   └── trash/                 Recoverably deleted profiles and old installations
└── Codex/                     One directory per CLI family
    ├── node_modules/          Example CLI package files
    ├── package.json           Example installation manifest
    ├── _shared/               Opt-in sessions, models, config, skills and MCP
    └── Profiles/
        ├── Default/
        │   ├── Default-Codex.Toml  Profile identity and sharing settings
        │   ├── workspace/     Starting workspace
        │   ├── logs/          Installer transcripts
        │   └── .codex/        CLI data and credentials
        └── Work/
            ├── Work-Codex.Toml
            ├── workspace/
            ├── logs/
            └── .codex/        Work's private CLI config, skills, MCP and login
```

Each CLI has one installation in its tool directory. Profiles receive separate HOME, AppData, XDG, and temporary directories inside their named folder, and start in their own `workspace/`. The `(profile name)-(CLI name).Toml` file records profile identity and OmniShell settings. CLI configuration keeps its native format, such as `.codex/config.toml`; the profile TOML is not passed to the CLI. OmniShell reads TOML setting edits at the next startup. Renaming a profile also renames its folder and TOML file. It updates exact old-folder paths in recognized CLI configuration files belonging to that tool's profiles and shared settings; project files, session databases, and logs are not rewritten. A failed rename restores the previous name and configuration, and an interrupted rename is completed or rolled back at startup. Deleting a custom profile moves its data, workspace, and logs to trash while keeping the shared CLI installation. The Default profile cannot be deleted. Profile names must be valid Windows folder names.

**Sharing is opt-in per CLI and profile.** Shared Sessions, Models, Config, Skills, and MCP are separate settings; all are off by default. Private skills and MCP servers remain in the CLI's own profile-local files. For example, Codex uses `.codex/skills/` and the `mcp_servers` entries in `.codex/config.toml`. Shared Config excludes MCP entries, so enabling it alone does not share MCP servers. When Shared Skills or Shared MCP is enabled, OmniShell copies that whole category through the tool's `_shared/` directory when a profile starts and exits. The picker shows `N/A` for a CLI without a verified sharing adapter; Aider currently has no Skills or MCP adapter. Each category is shared only among profiles of the same CLI. A CLI installation remains shared independently of these settings.

On upgrade from separate profile installations, OmniShell moves one installed copy to the tool directory and preserves the other copies under `_profiles/trash/legacy-runtimes/` for recovery. Old `profile.json` files become profile TOML files. Previously shared MCP entries found inside Shared Config are removed from the live shared copy and backed up under `_profiles/trash/legacy-shared-mcp/`; the individual profile's MCP entries remain. Archived copies still occupy disk space until removed.

## Development

Install Node.js 22.19 or newer, then clone the repository:

```powershell
git clone https://github.com/Utku4836/OmniShell.git
cd OmniShell
.\start.bat
```

The launcher installs the locked dependencies on first run. For development commands:

```powershell
cd app
npm ci
npm run check
npm test
npm run test:ui
npm run health
npm run dist
```

The UI smoke command uses temporary profiles and hidden Electron windows. The health command requires local CLI installations and checks their version commands through ConPTY. The portable build is written to `dist/`.

To regenerate the README artwork from the app's interface, run `npm run docs:assets` on Windows. The capture uses example profiles in a temporary directory and writes the images to `docs/images/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development conventions and [SECURITY.md](SECURITY.md) for reporting a security issue.

## License

[MIT](LICENSE) · Utku4836
