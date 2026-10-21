# CommitSmith — design

Date: 2026-10-21 · Status: draft for approval

CommitSmith is an open-source VS Code extension that writes git commit messages with the AI coding CLIs already installed on the user's machine (Claude Code, Codex), commits for the user, splits a messy working tree into several sensible commits, and pushes.

Mockups (open in a browser; they are HTML fragments, unstyled outside the brainstorm frame but readable): `docs/mockups/layout.html` (option A was chosen), `docs/mockups/smart-split-a.html`, `docs/mockups/model-picker.html` (left half was chosen; the right half, per-task models, was rejected).

## Why

The owner commits often in a large Unity repo with many changed files, some of them editor-generated binary/asset noise. Writing messages and grouping changes by hand is slow. They already pay for and use Claude Code and Codex locally, so the extension should drive those tools instead of asking for a separate API key.

## Goals

1. Three one-click actions in VS Code's own Source Control panel:
   - **Write message** — AI writes a commit message into the SCM commit input box. Nothing is committed. The user can edit it and commit with the normal Commit button.
   - **Write + Commit** — AI writes the message and the extension commits immediately.
   - **Push** — pushes the current branch.
2. **Smart split** — AI analyses the changes and proposes several commits; the user reviews and approves a plan; the extension then creates those commits in order.
3. **Scope rule (owner's decision):** if the Staged Changes group has files, every AI action looks only at staged files. If nothing is staged, it looks at all changes (and stages them as needed for Write + Commit / Smart split).
4. **AI and model picker:** a status-bar item shows the current tool and model (`✦ Claude Code · Sonnet ▾`). Clicking it opens a quick pick grouped by tool, listing that tool's models; tools that are not installed are shown disabled ("not found"). One selection is used for every action (owner rejected per-task models).
5. **Auto-detect installed AI CLIs** at activation and on demand (PATH lookup plus the usual install locations on Windows/macOS/Linux). No API keys in the extension.
6. **Open source and localizable:** UI strings go through VS Code's localization (`package.nls.json` + `vscode.l10n` bundles). Ship English (default) and Turkish. Adding a language must be just adding translation files.
7. **Works in any repository**, not tied to the owner's project.

## Non-goals (v1)

- A separate sidebar/activity-bar panel (option B was rejected; everything lives in the SCM panel plus one editor tab for the split plan).
- Hunk/line-level splitting. Smart split assigns whole files to commits. A file with unrelated hunks goes to one commit.
- Calling model HTTP APIs directly, managing API keys or billing.
- Creating branches, PRs, rebasing, amending, force-push.
- Supporting Visual Studio (the full IDE) — VS Code only.

## Anti-goals (would make it a failure even if it works)

- **Committing or pushing anything the user did not approve.** Smart split never commits before the user presses the approve button. Push to the repo's default branch (`main`/`master` or the remote HEAD) always asks first.
- **Leaving AI fingerprints the user didn't ask for.** No `Co-Authored-By`, "Generated with…", or session trailers in messages by default (setting, default on: strip them). The owner's team bans these.
- **Losing or mangling the user's index/working tree.** If a split run fails mid-way, stop, report which commits were made, and leave the remaining changes intact (staged state restored to what it was before the run, minus what was committed).
- Sending large binary blobs or whole generated asset files to the AI (slow, expensive, useless).

## Behaviour details

### New (untracked) files (owner left it to Claude: "do as you suggest")
- **Write + Commit with nothing staged** commits only changes to files git already tracks. New files are never added silently. When new files were left out, a notification says so ("3 new files were not included") and offers **Stage them** and **Smart split**.
- **Write message with nothing staged** writes the message for the same set Write + Commit would use (tracked changes only) and does not stage anything. If VS Code's own Commit button then commits a different set because of the user's `git.smartCommitChanges` settings, that is accepted. The extension does not fight the user's git settings.
- **Smart split** includes new files in the plan, because the plan is approved before anything is committed. New files are shown with a "new" tag, and a lone `.meta` is kept in the same commit as its asset.
- Setting `commitsmith.includeUntracked` (default `false`) lets the user opt in to including new files in Write + Commit as well.

### Placement (option A)
- SCM title bar (`scm/title`, only for git repositories): four icons — Write message (✦), Write + Commit (✦✓), Smart split (⧉), Push (⇡).
- Two text buttons under the commit box are shown in the mockup; if VS Code's contribution points cannot place buttons there, the title-bar icons plus a sparkle action on the input box are enough. The builder decides what the API allows.
- Multi-root / multiple repositories: actions apply to the repository whose SCM view the button was clicked in.

### Message generation
- Input to the AI: the diff of the scoped files, file list with status, current branch, the last ~20 commit subjects (to learn the repo's style, e.g. `fix(drag): …` Conventional Commits), and commit rules found in the repo's `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.gitmessage` if present.
- Binary and "large/generated" files: send only path, status and size, never content. Extension list and a size threshold are settings (sensible defaults include Unity `.asset`, `.prefab`, `.unity`, `.meta`, images, audio, fonts, archives; threshold e.g. 200 KB of diff per file). Total diff sent is capped; when over the cap, the largest file diffs are summarised to stats.
- Message language: setting, default English, independent of UI language.
- Output is post-processed: strip AI attribution trailers (unless the setting is off), trim code fences/quotes the model may wrap around the message.
- Progress notification with Cancel while the CLI runs; cancel kills the child process.

### Smart split
1. User clicks ⧉. Scope rule applies.
2. Progress notification: "<Tool> is analysing N files…" (cancellable).
3. AI returns a plan as structured JSON (groups: message, files, short reason, optional "uncertain" flag). Builder validates it: every scoped file appears exactly once (or in an "unassigned" bucket); unknown paths are rejected.
4. A webview editor tab "✦ Commit plan" opens:
   - each proposed commit: checkbox, editable message, file list, reason line;
   - commits the AI marked uncertain start unchecked with a warning ("Not sure this change was intended");
   - drag a file between commits; reorder commits; **Regroup** re-asks the AI; **Cancel** closes without changes;
   - "Push when done" checkbox (default off);
   - while the plan tab is open, SCM file rows show the commit number they will go to (decoration badge) if the API allows; otherwise skip.
5. **Commit checked** creates the commits in order, one group at a time. Unchecked groups and unassigned files remain as uncommitted changes.
   - **What content goes in (Claude's call, follows from "staged = my selection"):** in staged scope a commit takes exactly the *staged* content of each file. Edits the user left unstaged in the same file are never swept in and are still unstaged afterwards. In all-changes scope a commit takes the file as it is on disk. Staged-scope splitting therefore cannot be a plain "stage files, commit" loop. It needs git plumbing, for example a temporary index built from the saved staged blobs with `read-tree` / `update-index`. The rollback after a failed run is built on the same mechanism.
   - **Regroup keeps the user's review work (Claude's call):** files the user moved, messages they edited and commits they unticked are sent back to the AI as locked constraints. The AI regroups only what is unlocked, and plan validation checks that the locks were kept.
6. Git hooks run as normal. If a commit fails (hook rejects, conflict), stop, show the error and which commits were created.

### Push
- Pushes the current branch to its upstream; if none, offers to set upstream to `origin/<branch>`.
- Confirms before pushing to the default branch. Shows how many commits will go.
- Uses git's own credentials; no auth handling in the extension.

### AI tool adapters
- One adapter per CLI behind a common interface (detect, list models, run prompt → text). v1: Claude Code (`claude -p` non-interactive with a model flag) and Codex (`codex exec` with a model flag). Exact flags and output modes are for the builder to verify against the installed CLI versions.
- Model list: read from the CLI if it exposes one; otherwise a built-in default list per tool that the user can extend in settings (`commitsmith.models.<tool>`). The status-bar picker shows both.
- If the selected tool is missing at run time, show an error with a "Pick another" action (no silent fallback).
- The CLI runs with the repository root as working directory and must not be allowed to edit files: use each CLI's read-only / no-tools mode where available, and pass the diff in the prompt rather than letting the agent explore.
- **The user's own login is a hard requirement; isolation is best-effort (Claude's call).** The extension collects the repo's rule files itself and passes them in the prompt, so the CLI's own CLAUDE.md, memory, hooks, plugins and MCP servers are not needed and should be switched off where that keeps the subscription login working. Checked on 2026-10-21: Claude Code's `--bare` mode skips all of these but accepts only `ANTHROPIC_API_KEY` / `apiKeyHelper`, never the OAuth login. So do **not** use `--bare`. Instead combine an empty tool list (`--tools ""`), `--strict-mcp-config` with no MCP config, and `--setting-sources` / other flags as far as they cut hooks and plugins without touching auth. Verify this against the installed version. Apply the same idea to Codex (read-only sandbox, no extra tools). If some of the user's setup still loads, accept it rather than requiring an API key.

## Constraints

- TypeScript, VS Code extension API, uses the built-in `vscode.git` extension API for repository state (staged/working groups, input box, commit). Shell out to `git` only where the API lacks something.
- Windows is the owner's platform (Git Bash and PowerShell both present); must also work on macOS/Linux.
- License MIT. Public repo; no owner-specific paths, names or project rules hard-coded.
- Repository location: `E:\Main_Working\commitsmith` (its own git repo, outside the Unity project).

## Decisions made by Claude (not explicitly chosen by the owner)

- Name **CommitSmith** and the folder location — placeholders the owner can change.
- English default UI + Turkish translation; English default message language.
- "Strip AI attribution" setting on by default.
- Default-branch push confirmation.
- File-level (not hunk-level) splitting.
- Smart split respects the staged-only scope rule like the other actions.
- No automatic fallback to another AI tool.
- Partially staged files: staged scope commits only the staged content.
- Regroup keeps the user's edits as locked constraints.
- Keep the subscription login, never `--bare` / API key; isolation only as far as login allows.
- New files: left out of Write + Commit by default (opt-in setting), included in Smart split with a "new" tag.

## Left to the builder

- Exact CLI invocation flags, prompt wording, JSON schema for the plan.
- Default binary/generated extension list and size caps.
- Whether "two buttons under the commit box" and SCM row badges are achievable with the public API; degrade gracefully if not.
- Test strategy (unit tests for diff scoping, plan validation, trailer stripping; integration test with a fake CLI).
- Marketplace packaging and publishing (not part of v1 build; produce a working `.vsix`).
