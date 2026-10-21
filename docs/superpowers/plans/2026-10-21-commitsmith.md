# CommitSmith Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension that writes commit messages with the locally installed Claude Code / Codex CLIs, commits, splits changes into several approved commits, and pushes — from the built-in Source Control panel.

**Architecture:** All git and AI logic lives in plain Node modules (`src/git`, `src/ai`, `src/prompt`, `src/split`, `src/push`) that never import `vscode`, so they are tested with mocha against real temporary git repos and a fake CLI. A thin `src/vscode` layer wires them to commands, the SCM title bar, the status-bar picker, the SCM input box (via the built-in `vscode.git` API) and one webview tab for the split plan. Commits are made with a temporary index file (`GIT_INDEX_FILE`), so the user's real index is never rebuilt — only the committed paths are re-synced to the new HEAD.

**Tech Stack:** TypeScript 5, VS Code API (`engines.vscode ^1.95.0`), built-in `vscode.git` extension API v1, Node `child_process.execFile`, mocha + `tsx` for unit tests, esbuild bundle, `@vscode/vsce` for packaging.

**Spec:** `docs/superpowers/specs/2026-10-21-commitsmith-design.md` (mockups in `docs/mockups/`).

## Global Constraints

- Repo root: `E:\Main_Working\commitsmith`. License MIT. No owner-specific paths, names or project rules in code; the Unity file extensions are only defaults in a setting.
- Never commit or push without explicit user action; Smart split commits only after "Commit checked"; pushing to the default branch always asks first.
- `commitsmith.stripAiAttribution` default `true`: no `Co-Authored-By` AI trailer, "Generated with", 🤖 line or `*-Session:` line survives in a message.
- Scope rule: staged files non-empty → only staged content; else all changes. New (untracked) files are excluded from Write message / Write + Commit unless `commitsmith.includeUntracked` (default `false`); always included in Smart split with a "new" tag.
- Claude Code must run on the user's subscription login: never pass `--bare`, never require `ANTHROPIC_API_KEY`.
- AI CLIs get the diff in the prompt and no write-capable tools (Claude: `--tools ""`; Codex: `-s read-only`).
- All user-visible strings through `vscode.l10n.t` / `package.nls*.json`; ship `en` (default) and `tr`.
- Commit message language setting `commitsmith.messageLanguage` default `"English"`.
- Pass path lists to git with `--pathspec-from-file=- --pathspec-file-nul` (stdin) and set `GIT_LITERAL_PATHSPECS=1`; never put file lists on the command line.
- Git commits in this repo: only when the owner has asked for commits in the current conversation; never add AI co-author/session trailers to this repo's own commits. Commit steps below assume that permission.

## Review Focus

1. Paths with spaces and non-ASCII characters (`Oswald-Medium SDF.asset`, `Ödeme.cs`) must round-trip through status, diff, commit and the webview unchanged → tests in Task 1 and Task 3.
2. Unity moves are renames of an asset **and** its `.meta`; both old and new paths of each rename must end up in the same commit, or the commit breaks the project → tests in Task 3 and Task 6.
3. A pre-commit hook rejecting the 2nd of 3 groups: the 1st commit stays, the error names the hook output, the 2nd and 3rd groups' changes are still in the working tree/index exactly as before → test in Task 3.
4. The CLI exits non-zero, is not logged in, prints non-JSON, or exceeds the timeout: the user sees the CLI's stderr tail, nothing is staged or committed, the input box is untouched → tests in Task 5.
5. Hundreds of changed files (a Unity reimport) must not hit the Windows command-line limit or blow the prompt: pathspecs via stdin, diff payload capped → tests in Task 2 and Task 3.

---

## File Structure

```
package.json                  contributions, settings, scripts
package.nls.json / package.nls.tr.json   command titles, setting descriptions
l10n/bundle.l10n.tr.json      runtime strings (vscode.l10n.t)
tsconfig.json  .vscodeignore  .gitignore  LICENSE  README.md  CHANGELOG.md
esbuild.mjs                   bundles src/extension.ts → dist/extension.js
src/extension.ts              activate(): builds services, registers commands/status bar
src/git/gitRunner.ts          execFile wrapper for git
src/git/status.ts             porcelain v2 -z parser
src/git/scope.ts              scope rule
src/git/diffCollector.ts      diff payload with binary/large/cap handling
src/git/commitEngine.ts       temp-index commits for one or many groups
src/ai/types.ts               AiTool, ModelInfo, RunOptions, AiError
src/ai/exec.ts                spawn with stdin, timeout, AbortSignal
src/ai/claudeTool.ts          Claude Code adapter
src/ai/codexTool.ts           Codex adapter
src/ai/registry.ts            detection of all tools
src/prompt/repoContext.ts     rule files + recent subjects
src/prompt/prompts.ts         message prompt, split prompt, split JSON schema
src/message/clean.ts          strip fences/quotes/AI trailers
src/split/plan.ts             plan types + validation + .meta/rename pairing
src/push/push.ts              push info + decision
src/vscode/gitApi.ts          access to vscode.git Repository for a root
src/vscode/statusBar.ts       "✦ Claude Code · Sonnet ▾" + quick pick
src/vscode/commands.ts        writeMessage, writeAndCommit, smartSplit, push
src/vscode/planPanel.ts       webview tab for the split plan
media/plan.js  media/plan.css webview UI
test/helpers/tempRepo.ts      creates throwaway git repos
test/fixtures/fake-ai.mjs     fake CLI driven by env vars
test/**/*.test.ts             mocha tests
```

---

### Task 1: Scaffold, git runner, status parser, scope rule

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.vscodeignore`, `LICENSE`, `esbuild.mjs`, `src/git/gitRunner.ts`, `src/git/status.ts`, `src/git/scope.ts`, `test/helpers/tempRepo.ts`
- Test: `test/git/scope.test.ts`

**Interfaces:**
- Produces:
  - `runGit(cwd: string, args: string[], opts?: { input?: string | Buffer; env?: NodeJS.ProcessEnv; allowFail?: boolean }): Promise<{ stdout: string; stderr: string; code: number }>` — always sets `GIT_LITERAL_PATHSPECS=1`, `LC_ALL=C`, `maxBuffer` 64 MB; throws `GitError { args, code, stderr }` on non-zero unless `allowFail`.
  - `pathspecInput(paths: string[]): string` — NUL-joined, for `--pathspec-from-file=- --pathspec-file-nul`.
  - `type FileStatus = { path: string; origPath?: string; index: StatusCode; worktree: StatusCode; untracked: boolean }` with `StatusCode = '.' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U'`.
  - `readStatus(root: string): Promise<FileStatus[]>` — parses `git status --porcelain=v2 -z --untracked-files=all`.
  - `type Scope = { kind: 'staged' | 'all'; files: ScopedFile[]; leftOutUntracked: string[] }`, `type ScopedFile = { path: string; origPath?: string; change: 'added' | 'modified' | 'deleted' | 'renamed'; isNew: boolean }`.
  - `resolveScope(status: FileStatus[], opts: { includeUntracked: boolean }): Scope`.
  - `createTempRepo(files?: Record<string, string | Buffer>): Promise<{ root: string; git(...args: string[]): Promise<string>; write(p: string, c: string | Buffer): void; cleanup(): Promise<void> }>` — `git init -b main`, sets local `user.name/email`, `core.autocrlf=false`, commits the given files as "init".

- [ ] **Step 1: Scaffold** — `npm init`, dev deps `typescript @types/node @types/vscode@1.95 mocha @types/mocha tsx esbuild @vscode/vsce`; scripts `build` (esbuild), `test` (`mocha --import=tsx "test/**/*.test.ts"`), `package` (`vsce package`). `package.json`: `name: "commitsmith"`, `displayName: "%displayName%"`, `main: "./dist/extension.js"`, `activationEvents: ["onStartupFinished"]`, `extensionDependencies: ["vscode.git"]`, `l10n: "./l10n"`, `license: "MIT"`. `git init -b main` in the repo root (the docs folder already exists).
- [ ] **Step 2: Write the failing tests** in `test/git/scope.test.ts`:
  - `staged scope wins`: repo with `a.txt`, `b.txt` committed; edit both, stage `a.txt`, add untracked `c.txt` → `resolveScope(...)` gives `kind 'staged'`, files `['a.txt']`.
  - `partial stage stays staged scope`: edit `a.txt`, stage, edit again → `kind 'staged'`, `['a.txt']`.
  - `all scope excludes untracked by default`: edit `a.txt`, add `c.txt` → `kind 'all'`, files `['a.txt']`, `leftOutUntracked ['c.txt']`.
  - `includeUntracked adds new files`: same with `includeUntracked: true` → files `['a.txt','c.txt']`, `c.txt.isNew === true`, `leftOutUntracked []`.
  - `rename keeps origPath`: `git mv a.txt sub/a2.txt` → staged scope file `{ path: 'sub/a2.txt', origPath: 'a.txt', change: 'renamed' }`.
  - `odd paths round-trip`: files `Oswald-Medium SDF.asset` and `Ödeme ü.cs` edited → paths equal exactly.
- [ ] **Step 3: Run** `npm test` → FAIL (`resolveScope` not defined).
- [ ] **Step 4: Implement** `gitRunner.ts`, `status.ts` (v2 records: `1`, `2` (rename: path then origPath, NUL-separated), `u`, `?`; ignore `!`), `scope.ts` (staged = any entry with `index !== '.'`; all = entries with `worktree !== '.'` or untracked; `change` from the relevant side).
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "chore: scaffold extension, git status and scope rule"`.

---

### Task 2: Diff collector

**Files:**
- Create: `src/git/diffCollector.ts`
- Test: `test/git/diffCollector.test.ts`

**Interfaces:**
- Consumes: `runGit`, `pathspecInput`, `Scope`.
- Produces:
  - `type DiffOptions = { summaryOnlyExtensions: string[]; maxFileDiffBytes: number; maxTotalBytes: number }`; `DEFAULT_DIFF_OPTIONS` = extensions `.asset .prefab .unity .meta .mat .anim .controller .png .jpg .jpeg .psd .tga .exr .wav .mp3 .ogg .fbx .ttf .otf .zip .dll`, `maxFileDiffBytes 200_000`, `maxTotalBytes 400_000`.
  - `type FileDiff = { path: string; origPath?: string; change: ScopedFile['change']; isNew: boolean; binary: boolean; sizeBytes: number; added: number; removed: number; patch?: string; summarized: boolean }`.
  - `collectDiff(root: string, scope: Scope, opts: DiffOptions): Promise<FileDiff[]>` — staged: `git diff --cached`; all: `git diff HEAD` (or against the empty tree when there is no HEAD); untracked text files: patch built from file content. Numstat from `--numstat -z`; `-` counts mean binary.

- [ ] **Step 1: Write the failing tests:**
  - `staged diff ignores unstaged edits`: stage "one" in `a.txt`, then add "two" unstaged → patch contains `+one`, not `+two`.
  - `summary-only extension has no patch`: change `x.asset` → `patch === undefined`, `summarized === true`, `added/removed` set.
  - `binary detected`: write 1 KB of random bytes to `img.bin` → `binary === true`, no patch.
  - `file over maxFileDiffBytes is summarized`: `maxFileDiffBytes: 100`, 50-line edit → `summarized`.
  - `total cap summarizes largest first`: three files 300/200/100 bytes of patch, `maxTotalBytes: 350` → the 300-byte one summarized, others keep patches.
  - `600 files stay under the command line limit`: edit 600 files with 120-char names → resolves without error (Review Focus 5).
- [ ] **Step 2: Run** `npm test -- --grep diffCollector` → FAIL.
- [ ] **Step 3: Implement `collectDiff`** — one `git diff` call per scope with pathspecs via stdin, split the patch per file on `diff --git` headers matched against numstat paths.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(git): collect scoped diff with binary and size caps`.

---

### Task 3: Commit engine (temporary index)

**Files:**
- Create: `src/git/commitEngine.ts`
- Test: `test/git/commitEngine.test.ts`

**Interfaces:**
- Consumes: `runGit`, `pathspecInput`, `Scope['kind']`.
- Produces:
  - `type CommitGroup = { message: string; paths: string[] }` (paths include both sides of a rename).
  - `type CommitResult = { done: { sha: string; message: string }[]; failed?: { index: number; message: string; error: string } }`.
  - `commitGroups(root: string, kind: 'staged' | 'all', groups: CommitGroup[], signal?: AbortSignal): Promise<CommitResult>` — never throws for a git failure on a group; returns `failed` and stops.

Algorithm per group (this is the part the tests do not fully determine):
```
tmp = <git-dir>/commitsmith-index-<random>
GIT_INDEX_FILE=tmp git read-tree HEAD            (or: git read-tree --empty when no HEAD)
if kind == 'staged':
    entries = git ls-files -s -z -- <paths>   (from the REAL index)  → "mode sha 0\tpath"
    GIT_INDEX_FILE=tmp git update-index --index-info  < entries
    paths present in HEAD but absent from the real index → GIT_INDEX_FILE=tmp git update-index --force-remove
else:
    GIT_INDEX_FILE=tmp git add -A --pathspec-from-file=- --pathspec-file-nul  < paths
GIT_INDEX_FILE=tmp git commit -q -F -  < message        (hooks run; no --no-verify)
git reset -q --pathspec-from-file=- --pathspec-file-nul  < paths   (real index: committed paths = new HEAD)
finally delete tmp
```

- [ ] **Step 1: Write the failing tests:**
  - `staged commit takes only staged content`: stage `one` in `a.txt`, add `two` unstaged → after `commitGroups(root,'staged',[{message:'m',paths:['a.txt']}])`: `git show HEAD:a.txt` has `one` not `two`; `git diff` (unstaged) still shows `+two`; `git diff --cached` empty.
  - `other staged files stay staged`: stage `a.txt` and `b.txt`, commit group `['a.txt']` → `git diff --cached --name-only` is `b.txt`.
  - `all scope, three groups in order`: edit `a`,`b`,`c` → three groups → `git log --format=%s -3` is `[m3, m2, m1]`; working tree clean.
  - `new file and deletion`: add untracked `n.txt`, delete `a.txt`, kind `'all'`, one group → HEAD has `n.txt`, lacks `a.txt`.
  - `rename both sides`: `git mv a.txt b.txt` → group `['b.txt','a.txt']` → HEAD has `b.txt`, not `a.txt`; `git status --porcelain` empty.
  - `hook rejects 2nd group`: install `.git/hooks/pre-commit` that exits 1 when `git diff --cached --name-only` contains `b.txt` (a `.sh` with `#!/bin/sh` — Git for Windows runs it) → `done.length === 1`, `failed.index === 1`, `failed.error` contains the hook's echo text; `b.txt` and `c.txt` edits still present and unstaged (Review Focus 3).
  - `no HEAD yet`: fresh `git init`, add `a.txt` untracked, kind `'all'` → one commit created.
  - `odd paths`: `Oswald-Medium SDF.asset`, `Ödeme ü.cs` → committed, status clean.
  - `600 files in one group` → commits without error.
- [ ] **Step 2: Run** `npm test -- --grep commitEngine` → FAIL.
- [ ] **Step 3: Implement `commitGroups`** following the algorithm above.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(git): commit groups through a temporary index`.

---

### Task 4: Repo context, prompts, message cleaning

**Files:**
- Create: `src/prompt/repoContext.ts`, `src/prompt/prompts.ts`, `src/message/clean.ts`
- Test: `test/prompt/prompts.test.ts`, `test/message/clean.test.ts`

**Interfaces:**
- Consumes: `runGit`, `FileDiff`.
- Produces:
  - `type RepoContext = { branch: string; recentSubjects: string[]; rules: { file: string; text: string }[] }`.
  - `readRepoContext(root: string): Promise<RepoContext>` — `git log -20 --format=%s` (empty list when no HEAD); rule files `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.gitmessage`, `.github/CONTRIBUTING.md` at repo root, each truncated to 8 000 chars, total 16 000.
  - `buildMessagePrompt(ctx: RepoContext, diffs: FileDiff[], language: string): string`.
  - `type PlanLocks = { groups: { message: string; files: string[] }[] }` — defined here (groups whose message the user edited or into which they moved files); Task 6 imports it.
  - `buildSplitPrompt(ctx: RepoContext, diffs: FileDiff[], language: string, locks?: PlanLocks): string` — locked groups are listed as fixed and their files excluded from what the AI may regroup.
  - `SPLIT_SCHEMA` — JSON Schema object: `{ groups: [{ message: string, files: string[], reason: string, uncertain: boolean }], unassigned: string[] }`, all required, `additionalProperties: false`.
  - `cleanMessage(raw: string, stripAttribution: boolean): string`.

Prompt rules that must appear in both prompts (exact wording is the builder's): follow the style of `recentSubjects`; obey commit rules in `rules`; write in `language`; output only the message (message prompt) / only JSON matching the schema (split prompt); summarized files are described by path, status and size only; never add co-author or "generated by" lines; split prompt: every listed path exactly once, `.meta` with its asset, both rename sides together, mark `uncertain: true` for changes that look accidental (settings/editor noise).

- [ ] **Step 1: Write the failing tests:**
  - `cleanMessage strips fences and quotes`: "```\nfix: x\n```" → `fix: x`; `"\"fix: x\""` → `fix: x`.
  - `cleanMessage strips AI trailers`: input ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`, `Claude-Session: abc`, `Co-authored-by: Codex <codex@openai.com>` → none remain; a human trailer `Co-Authored-By: Ali <ali@x.com>` stays.
  - `stripAttribution false keeps trailers`.
  - `cleanMessage collapses 3+ blank lines and trims`.
  - `message prompt lists summarized file without patch`: a `FileDiff` with `summarized: true` → prompt contains its path and size, not its patch text.
  - `prompt contains rules and subjects`: ctx with rule text `NEVER add Claude` and subject `fix(drag): x` → both substrings present.
  - `readRepoContext truncates rules`: 20 000-char `CLAUDE.md` → `rules[0].text.length <= 8000`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(prompt): repo context, prompts and message cleaning`.

---

### Task 5: AI tool adapters and detection

**Files:**
- Create: `src/ai/types.ts`, `src/ai/exec.ts`, `src/ai/claudeTool.ts`, `src/ai/codexTool.ts`, `src/ai/registry.ts`, `test/fixtures/fake-ai.mjs`
- Test: `test/ai/adapters.test.ts`

**Interfaces:**
- Produces:
  - `type ToolId = 'claude' | 'codex'`; `type ModelInfo = { id: string; label: string; detail?: string }`.
  - `type RunOptions = { model: string; cwd: string; jsonSchema?: object; timeoutMs: number; signal?: AbortSignal }`.
  - `interface AiTool { id: ToolId; displayName: string; detect(): Promise<string | undefined>; listModels(extra: string[]): Promise<ModelInfo[]>; run(prompt: string, opts: RunOptions): Promise<string> }` — `run` returns the final text (or the JSON string when `jsonSchema` is set).
  - `class AiError extends Error { kind: 'notFound' | 'exit' | 'timeout' | 'cancelled' | 'badOutput'; stderrTail: string }` (last 2 000 chars of stderr).
  - `execCli(exe: string, args: string[], stdin: string, opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }>` — kills the process tree on timeout/abort (`taskkill /T /F /PID` on Windows).
  - `createClaudeTool(env?: { exeOverride?: string }): AiTool`, `createCodexTool(env?: { exeOverride?: string; codexHome?: string }): AiTool`.
  - `detectTools(tools: AiTool[]): Promise<{ tool: AiTool; exe?: string }[]>`.

Adapter facts (checked on the owner's machine 2026-10-21; re-verify flags with `--help` of the installed version):
- **Claude Code** 2.1.296, on PATH (`claude`, WinGet link `%LOCALAPPDATA%\Microsoft\WinGet\Links\claude`). Also look in `~/.local/bin`, `~/.claude/local`, `%APPDATA%\npm`. Run: `claude -p --model <id> --output-format json --tools "" --strict-mcp-config --no-session-persistence [--json-schema '<schema>']`, prompt on stdin. Parse stdout JSON; text in `result`, structured output in its structured field (record a real output into `test/fixtures/claude-output.json` once and parse against it). Try `--setting-sources project` to drop user hooks; keep it only if a run still authenticates. No `--bare`. Models: built-in `haiku`, `sonnet`, `opus` + `commitsmith.models.claude`.
- **Codex** not on PATH here; installed at `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe` (0.126) and `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` (0.163). Detection: PATH first, then those locations; when several, run `--version` on each and pick the highest. Run: `codex exec -m <id> -s read-only --ephemeral --skip-git-repo-check -C <cwd> -o <tmpfile> [--output-schema <schemafile>] -` with the prompt on stdin (verify `-` reads stdin; else pass the prompt as the argument via a temp file). Read the answer from `<tmpfile>`. Models: `~/.codex/models_cache.json` (`$CODEX_HOME` overrides `~/.codex`) → `models[]` with `visibility === "list"`, `id = slug`, `label = display_name`; fall back to `commitsmith.models.codex` when the file is missing.

- [ ] **Step 1: Write `test/fixtures/fake-ai.mjs`** — reads stdin; behaviour from env: `FAKE_MODE=ok|exit|hang|garbage`, `FAKE_OUT` (stdout text), writes args to `FAKE_ARGS_FILE`; for `-o <file>` writes `FAKE_OUT` there (Codex style).
- [ ] **Step 2: Write the failing tests** (adapters with `exeOverride` = a `.cmd`/sh shim launching `node fake-ai.mjs`):
  - `claude passes model, no tools, no --bare`: args contain `--model sonnet`, `--tools`, `--strict-mcp-config`, not `--bare`.
  - `claude parses result field`: `FAKE_OUT` = recorded fixture → returns its `result` text.
  - `codex reads -o file and uses read-only sandbox`: args contain `-s read-only`, `--ephemeral`; returns `FAKE_OUT`.
  - `codex models from cache`: temp `codexHome` with a cache of 3 models, one `hide` → 2 models, ids are slugs.
  - `exit non-zero → AiError exit with stderr tail` (Review Focus 4).
  - `garbage when jsonSchema set → AiError badOutput`.
  - `hang → AiError timeout within timeoutMs + 2s, process gone`.
  - `abort signal → AiError cancelled`.
  - `detect returns undefined for missing exe`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** the five modules.
- [ ] **Step 5: Run** → PASS. Then one manual real run each: `npx tsx -e` script calling `createClaudeTool().run("Say OK", {model:"haiku",...})` and the same for Codex → both print a reply without asking for an API key. Record Claude's raw JSON to the fixture.
- [ ] **Step 6: Commit** — `feat(ai): Claude Code and Codex adapters with detection`.

---

### Task 6: Split plan validation

**Files:**
- Create: `src/split/plan.ts`
- Test: `test/split/plan.test.ts`

**Interfaces:**
- Consumes: `ScopedFile`, `CommitGroup`, `PlanLocks` (from `src/prompt/prompts.ts`).
- Produces:
  - `type PlanGroup = { id: string; message: string; files: string[]; reason: string; uncertain: boolean; checked: boolean; locked: boolean }`.
  - `type SplitPlan = { groups: PlanGroup[]; unassigned: string[] }`.
  - `class PlanError extends Error { unknownPaths: string[]; duplicatePaths: string[] }`.
  - `parsePlan(json: string, scoped: ScopedFile[], locks?: PlanLocks): SplitPlan` — throws `PlanError` on paths not in scope or listed twice; scoped paths the AI left out go to `unassigned`; `checked = !uncertain`; locked groups are re-inserted unchanged and their files removed from AI groups.
  - `pairCompanions(plan: SplitPlan, scoped: ScopedFile[]): SplitPlan` — moves `X.meta` into the group holding `X` (and `X` into the group holding `X.meta` when `X` is unassigned); a rename's `origPath` travels with its `path`.
  - `toCommitGroups(plan: SplitPlan, scoped: ScopedFile[]): CommitGroup[]` — checked groups only, in order, rename origPaths added.

- [ ] **Step 1: Write the failing tests:**
  - `valid plan parses, uncertain unchecked`.
  - `unknown path → PlanError.unknownPaths`.
  - `duplicate path → PlanError.duplicatePaths`.
  - `missing path → unassigned`.
  - `meta follows asset`: `Foo.cs` in g1, `Foo.cs.meta` in g2 → both in g1 (Review Focus 2).
  - `rename origPath added in toCommitGroups`: scoped `{path:'b.cs', origPath:'a.cs'}` → group paths contain both.
  - `locks survive regroup`: locks `[{message:'mine', files:['a.txt']}]`, AI JSON puts `a.txt` elsewhere → result has a group `mine` with exactly `['a.txt']`, `locked: true`, and `a.txt` nowhere else.
  - `unchecked groups excluded from toCommitGroups`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(split): plan validation, companions and locks`.

---

### Task 7: Push logic

**Files:**
- Create: `src/push/push.ts`
- Test: `test/push/push.test.ts`

**Interfaces:**
- Produces:
  - `type PushInfo = { branch: string; upstream?: string; ahead: number; defaultBranch: string; remotes: string[] }`.
  - `readPushInfo(root: string): Promise<PushInfo>` — upstream from `rev-parse --abbrev-ref @{u}` (allowFail); ahead from `rev-list --count @{u}..HEAD` (no upstream → count of commits not on any remote branch: `rev-list --count HEAD --not --remotes`); default branch from `symbolic-ref --short refs/remotes/origin/HEAD` stripped of `origin/`, else `main` if it exists, else `master`.
  - `type PushDecision = { kind: 'nothing' } | { kind: 'noRemote' } | { kind: 'setUpstream'; remote: string } | { kind: 'push'; confirmDefault: boolean }`.
  - `decidePush(info: PushInfo): PushDecision` — `noRemote` when no remotes; `setUpstream` (remote `origin` if present, else first) when no upstream; `nothing` when `ahead === 0`; otherwise `push` with `confirmDefault = branch === defaultBranch`.
  - `runPush(root: string, d: { kind: 'push' } | { kind: 'setUpstream'; remote: string }, branch: string): Promise<void>` — `git push` or `git push -u <remote> <branch>`.

- [ ] **Step 1: Write the failing tests** — bare repo as `origin` in a temp dir: `ahead count after two commits is 2`; `main is default and needs confirm`; `feature branch no confirm`; `no upstream → setUpstream origin`; `ahead 0 → nothing`; `no remotes → noRemote`; `runPush setUpstream pushes and sets @{u}`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(push): push info and decision`.

---

### Task 8: VS Code wiring — status bar picker, Write message, Write + Commit, Push, localization

**Files:**
- Create: `src/extension.ts`, `src/vscode/gitApi.ts`, `src/vscode/statusBar.ts`, `src/vscode/commands.ts`, `package.nls.json`, `package.nls.tr.json`, `l10n/bundle.l10n.tr.json`
- Modify: `package.json` (contributes)
- Test: `test/vscode/manifest.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `getRepository(arg: unknown): Promise<{ root: string; repo: GitRepository } | undefined>` — `arg` is the `SourceControl` passed by an `scm/title` command (`arg.rootUri`); falls back to the only repository, else a quick pick of repositories. `GitRepository` = the `Repository` type from the vscode.git API (copy `git.d.ts` from the vscode repo into `src/vscode/git.d.ts`).
  - `class ToolPicker { current(): { tool: AiTool; model: string } | undefined; pick(): Promise<void>; refresh(): Promise<void> }` — status bar text `$(sparkle) <displayName> · <model label>`; tooltip lists detected tools; quick pick with a `QuickPickItemKind.Separator` per tool, a "✓" on the current model, missing tools shown as a disabled-looking item "not found" that does nothing; selection saved to global settings `commitsmith.tool` and `commitsmith.model`.
  - Commands `commitsmith.writeMessage`, `commitsmith.writeAndCommit`, `commitsmith.smartSplit` (stub that shows "coming next" until Task 9), `commitsmith.push`, `commitsmith.pickModel`.

Behaviour:
- Write message: `readStatus` → `resolveScope` (with `includeUntracked` setting) → empty → info "Nothing to describe" → `collectDiff` → `buildMessagePrompt` → `tool.run` inside `withProgress({ location: Notification, cancellable: true })` titled "<tool> is writing the message…" → `cleanMessage` → `repo.inputBox.value = message`. Never stages.
- Write + Commit: same, then `commitGroups(root, scope.kind, [{ message, paths: scope paths + rename origPaths }])` → `repo.status()` to refresh SCM → info "Committed <short sha>". If `leftOutUntracked.length`, notification "{0} new files were not included" with buttons "Stage them" (`git add` those paths) and "Smart split".
- Push: `readPushInfo` → `decidePush` → `nothing`: info "Nothing to push"; `noRemote`: error; `setUpstream`: modal "Publish branch {0} to {1}?"; `push` with `confirmDefault`: modal warning "Push {0} commits to {1}?"; otherwise push directly with progress; afterwards `repo.status()`.
- Tool missing at run time: error "{0} was not found" with button "Pick another" → `pickModel`. `AiError` → error message with its kind and the stderr tail in an output channel "CommitSmith" (button "Show log").
- `package.json` contributes: the five commands with codicons (`$(sparkle)` write, `$(check-all)` write + commit, `$(split-horizontal)` smart split, `$(cloud-upload)` push), `menus.scm/title` for the first four with `when: scmProvider == git` and `group: navigation`, `commandPalette` entries; also try `scm/inputBox` for `writeMessage` — keep it only if VS Code accepts it without a proposed API, otherwise drop it. Settings: `commitsmith.tool` (enum claude/codex), `commitsmith.model` (string), `commitsmith.messageLanguage` (default `"English"`), `commitsmith.includeUntracked` (false), `commitsmith.stripAiAttribution` (true), `commitsmith.summaryOnlyExtensions` (default list from Task 2), `commitsmith.maxFileDiffBytes`, `commitsmith.maxTotalBytes`, `commitsmith.timeoutSeconds` (180), `commitsmith.models.claude`, `commitsmith.models.codex` (string arrays, default `[]`).
- Every title/description in `package.nls.json` (en) + `package.nls.tr.json`; every runtime string via `vscode.l10n.t` with Turkish in `l10n/bundle.l10n.tr.json`. Turkish titles: "Mesaj yaz", "Mesaj yaz ve commit et", "Akıllı böl", "Push", "AI ve model seç".

- [ ] **Step 1: Write the failing test** `manifest.test.ts`: every `%key%` in `package.json` exists in both nls files; every `vscode.l10n.t("…")` literal in `src/**` has a key in `bundle.l10n.tr.json`; every command in `contributes.commands` is registered in `src/extension.ts` (string search).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` and `npm run build` → PASS, no TypeScript errors.
- [ ] **Step 5: Manual check** — `F5` (Extension Development Host) on a throwaway repo made with `createTempRepo`-style commands: icons appear in Source Control; status bar shows the detected tool; picker lists Claude models and Codex models from the cache; Write message fills the input box and stages nothing; Write + Commit commits only staged content when something is staged; new-file notification appears; Push to a local bare `origin` on `main` asks first. Switch VS Code display language to Turkish (`Configure Display Language`) → titles are Turkish.
- [ ] **Step 6: Commit** — `feat(vscode): source control actions, model picker, en/tr strings`.

---

### Task 9: Smart split — plan tab

**Files:**
- Create: `src/vscode/planPanel.ts`, `media/plan.js`, `media/plan.css`
- Modify: `src/vscode/commands.ts` (replace the `smartSplit` stub), `l10n/bundle.l10n.tr.json`
- Test: `test/vscode/planMessages.test.ts`

**Interfaces:**
- Consumes: `parsePlan`, `pairCompanions`, `toCommitGroups`, `commitGroups`, `buildSplitPrompt`, `SPLIT_SCHEMA`, `readPushInfo`/`decidePush`/`runPush`.
- Produces:
  - Webview → extension messages: `{ type: 'commit'; plan: SplitPlan; pushAfter: boolean } | { type: 'regroup'; locks: PlanLocks } | { type: 'cancel' }`.
  - Extension → webview: `{ type: 'plan'; plan: SplitPlan; toolLabel: string; fileCount: number; branch: string; newFiles: string[] } | { type: 'busy'; text: string } | { type: 'result'; result: CommitResult } | { type: 'error'; text: string }`.
  - `applyEdit(plan: SplitPlan, edit: { kind: 'move'; file: string; toGroupId: string } | { kind: 'message'; groupId: string; text: string } | { kind: 'toggle'; groupId: string } | { kind: 'reorder'; groupId: string; delta: -1 | 1 }): SplitPlan` — pure, in `src/split/plan.ts`; moving a file or editing a message sets `locked: true` on the touched groups; moving a file moves its `.meta` companion too.
  - `locksOf(plan: SplitPlan): PlanLocks`.

Behaviour (layout per `docs/mockups/smart-split-a.html`):
- Scope rule as everywhere, but untracked files always included. Progress notification "<tool> is analysing {0} files…" (cancellable) → `run` with `jsonSchema: SPLIT_SCHEMA` → `parsePlan` + `pairCompanions`. On `PlanError` retry once with the error appended to the prompt; second failure → error message.
- Opens `WebviewPanel` "✦ Commit plan" in `ViewColumn.Active`, one panel at a time (re-focus if open). Header: "<tool> proposes {0} commits", sub-line file count · branch. Each group: checkbox, editable message input, file list (new files tagged "new"; `.meta` shown indented under its asset), reason, warning line for uncertain groups. Files draggable between groups and to an "Unassigned" box. Buttons "Commit checked ({0})", "Regroup", "Cancel", checkbox "Push when done". Uses VS Code theme CSS variables (`--vscode-*`), CSP with nonce, no external resources.
- Commit → `commitGroups` → `repo.status()` → webview shows the result list (sha + message per commit; on failure the failed group and error) → if `pushAfter` and no failure: the Push command's flow (including the default-branch confirmation).
- Regroup → AI call with `locks` → new plan replaces the old one.
- While the tab is open, a `FileDecorationProvider` puts the group number (badge `1`, `2`, … ; `?` for unassigned) on those files, which VS Code also shows in the Source Control list. Cleared when the tab closes.
- If the working tree changes while the tab is open (`repo.state.onDidChange`), show a banner "Changes changed since this plan — Regroup before committing" and disable Commit until Regroup.

- [ ] **Step 1: Write the failing tests** for `applyEdit` / `locksOf`: `move sets locked on both groups and carries .meta`; `message edit locks group`; `toggle flips checked only`; `reorder swaps neighbours, no-op at edges`; `locksOf returns only locked groups`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `applyEdit`, `locksOf`, the panel and the webview.
- [ ] **Step 4: Run** `npm test`, `npm run build` → PASS.
- [ ] **Step 5: Manual check** in the Extension Development Host on a throwaway repo with: two related `.cs` edits, a new `Foo.cs` + `Foo.cs.meta`, a renamed `Bar.png` + `.meta`, a changed `QualitySettings.asset`, a file with a space in its name. Expect: plan tab opens; `.meta` files sit with their assets; moving a file then Regroup keeps it where it was moved; unchecking a group leaves its files uncommitted; Commit creates the commits in the shown order; a pre-commit hook that rejects one group shows the error and the remaining changes are intact; Push when done on `main` asks first.
- [ ] **Step 6: Commit** — `feat(split): smart split plan tab`.

---

### Task 10: README, packaging, end-to-end check

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `media/icon.png` (128×128, simple sparkle + branch glyph)
- Modify: `package.json` (`publisher` placeholder `"commitsmith"`, `repository`, `icon`, `categories: ["SCM Providers", "AI"]`)

- [ ] **Step 1: Write README** — what it does, supported CLIs and how they are found, the scope rule, new-file rule, settings table, privacy note (diff is sent to the chosen CLI's provider; summary-only files are not), how to add a translation (`package.nls.<lang>.json` + `l10n/bundle.l10n.<lang>.json`), screenshots placeholder.
- [ ] **Step 2: Package** — `npm run build && npx vsce package` → `commitsmith-0.1.0.vsix` created without warnings other than the missing-repository one if no remote yet.
- [ ] **Step 3: Install and check** — `code --install-extension commitsmith-0.1.0.vsix`, restart, open a throwaway repo, run Write message with Claude (haiku) and with Codex, then Smart split once. All work without an API key.
- [ ] **Step 4: Commit** — `docs: readme and packaging`.
