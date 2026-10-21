# CommitSmith

Write git commit messages with the AI command-line tools you already have installed (**Claude Code** or **Codex**), commit, split a messy working tree into several approved commits, and push, all from VS Code's Source Control panel. No API key is needed: CommitSmith uses the CLI's own login.

**Status:** v0.1.0, not yet on the Marketplace. Build it from source (see Development).

<!-- Screenshots: add media/screenshots/*.png here before publishing. -->

## Actions

Four buttons appear in the title bar of the Source Control panel (and in the Command Palette under "CommitSmith"):

| Action | What it does |
| --- | --- |
| **Write message** (sparkle) | Reads your changes, asks the AI, and fills the commit message box. Stages nothing and commits nothing. |
| **Write message and commit** (check-all) | Same, then commits. |
| **Smart split** (split) | Asks the AI to group the changes into several commits and opens a plan tab. You can drag files between commits, edit messages, regroup, and approve; CommitSmith then commits them one by one. Optionally pushes when done. |
| **Push** (cloud-upload) | Pushes the current branch. Publishing a new branch asks first. Pushing the repository's default branch (for example `main`) asks for confirmation. |

"Choose AI and model" (Command Palette) picks the tool (Claude Code or Codex) and the model.

## Which changes are used

- **Scope:** if anything is staged, only the staged files are used. Otherwise all changes are used.
- **New (untracked) files:** left out of *Write message* and *Write message and commit* unless `commitsmith.includeUntracked` is on. *Smart split* always includes them and marks them with a "new" tag. A Unity `.meta` file always stays in the same commit as its asset.

## Supported AI tools

CommitSmith looks for the executable on your `PATH` first, then in these fallback places:

- **Claude Code** (`claude`): `~/.local/bin`, `~/.claude/local`, and on Windows `%APPDATA%\npm` (`claude.exe` / `claude.cmd`).
- **Codex** (`codex`): on Windows `%LOCALAPPDATA%\OpenAI\Codex\bin` (and its version sub-folders; the newest version wins). Outside Windows, Codex is found via `PATH` only.

Install and sign in to the tool in a terminal first. Models: Claude shows Haiku, Sonnet and Opus plus any ids in `commitsmith.models.claude`; Codex lists the models its own cache (`$CODEX_HOME/models_cache.json`, default `~/.codex`) marks as listed (visibility `list`) and falls back to `commitsmith.models.codex`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `commitsmith.tool` | `claude` | The AI command-line tool that writes commit messages (`claude` or `codex`). |
| `commitsmith.model` | `""` | Model id passed to the tool. Empty means the tool's first listed model. |
| `commitsmith.messageLanguage` | `English` | Language of generated commit messages, for example English or Turkish. |
| `commitsmith.includeUntracked` | `false` | Include new (untracked) files when writing a message or committing. Smart split always includes them. |
| `commitsmith.stripAiAttribution` | `true` | Remove Co-Authored-By AI trailers, "Generated with" lines and session lines from generated messages. |
| `commitsmith.summaryOnlyExtensions` | `.asset .prefab .unity .meta .mat .anim .controller .png .jpg .jpeg .psd .tga .exr .wav .mp3 .ogg .fbx .ttf .otf .zip .dll` | File extensions whose diff is summarised instead of sent in full (binary or generated assets). |
| `commitsmith.maxFileDiffBytes` | `200000` | Largest diff, in bytes, sent for a single file before it is summarised. |
| `commitsmith.maxTotalBytes` | `400000` | Largest total diff, in bytes, sent to the AI. |
| `commitsmith.timeoutSeconds` | `180` | Seconds to wait for the AI before giving up. |
| `commitsmith.models.claude` | `[]` | Extra Claude model ids to offer in the picker. |
| `commitsmith.models.codex` | `[]` | Codex model ids to offer when its model cache is not available. |

## Privacy

- Your diff is sent to the chosen CLI's provider (Anthropic for Claude Code, OpenAI for Codex), under your own account and its terms. CommitSmith has no server and sends nothing anywhere else.
- Summary-only files (see `summaryOnlyExtensions`), binary files, and files over the size limits are sent as name and size only, not content.
- **Claude Code** runs with no tools, no MCP servers and no settings files, so a repository's own hooks never run.
- **Codex** runs in a read-only sandbox with an ephemeral session. It may read repository files and uses your own Codex configuration.

## Workspace Trust

CommitSmith runs git and external programs, so it is disabled in untrusted workspaces. Trust the folder to use it.

## Add a translation

Display language follows VS Code. To add one (for example German, `de`):

1. Copy `package.nls.json` to `package.nls.de.json` and translate the values (command titles and setting descriptions).
2. Copy `l10n/bundle.l10n.tr.json` to `l10n/bundle.l10n.de.json` and translate the values (messages shown at runtime); keep the keys and `{0}` placeholders.

Turkish (`tr`) is included as an example.

## Development

```
npm install
npm test               # unit tests (mocha)
npm run test:vscode    # smoke test inside a real VS Code
npm run build          # bundle to dist/
npm run package        # builds commitsmith-0.1.0.vsix
```

Press **F5** to start an Extension Development Host. `scripts/make-icon.mjs` regenerates `media/icon.png`.

Manual check (in an Extension Development Host, on a throwaway git repo):

- [ ] The four icons show in the Source Control title bar.
- [ ] "Choose AI and model" lists models for the selected tool.
- [ ] Write message fills the box and stages nothing.
- [ ] Write message and commit works with staged content.
- [ ] A new file shows the new-file notification (and is left out unless `includeUntracked`).
- [ ] Smart split: drag-and-drop between commit tabs works; Regroup keeps moved files; a pre-commit hook rejection shows an error and the remaining changes stay intact.
- [ ] Push on `main` asks first.
- [ ] With Turkish as display language, titles and messages are Turkish.

## Türkçe özet

CommitSmith, bilgisayarında kurulu Claude Code veya Codex komut satırı araçlarıyla commit mesajı yazar. API anahtarı gerekmez; aracın kendi girişi kullanılır. Kaynak Denetimi panelindeki dört düğme: mesaj yaz, mesaj yaz ve commit et, akıllı bölme (değişiklikleri onayına sunulan birkaç commit'e ayırır) ve push. Dosya hazırlandıysa (staged) yalnızca onlar, değilse tüm değişiklikler kullanılır. Yeni dosyalar `commitsmith.includeUntracked` açık değilse atlanır; akıllı bölme her zaman dahil eder. Varsayılan dala push etmeden önce sorulur. Fark (diff), seçtiğin aracın sağlayıcısına kendi hesabınla gönderilir; ikili ve çok büyük dosyaların yalnızca adı ve boyutu gider. Güvenilmeyen çalışma alanlarında devre dışıdır. Türkçe arayüz hazırdır.

## License

MIT
