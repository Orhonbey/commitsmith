# Changelog

## 0.3.0

- The Activity Bar panel now looks like Source Control: a commit message box synced with the Source Control box, the four actions (Push shows the commits waiting), an info line, and a native **Changes** tree with Staged Changes, Changes and New Files.
- Click a file to open its diff; inline Stage, Unstage, Discard changes and Open file; Stage all, Unstage all and Discard all on the groups; Copy relative path in the context menu. Discard always asks first and is never offered for new files.
- **Recent** is now its own collapsed tree; click a commit to copy its id.
- Groups show at most 500 files, then "… n more files".

## 0.2.0

- Activity Bar panel: a CommitSmith icon opens a small sidebar with the current AI and model, a repository chooser, the staged/all scope, the four actions, the push status and the last 5 actions of the session.
- The busy guard and the recent-actions list are shared between the commands and the panel.

## 0.1.0

- Write message: fill the Source Control commit box using Claude Code or Codex.
- Write message and commit.
- Smart split: AI groups changes into several commits, with a plan tab to review, drag files between commits, regroup, and approve.
- Push, with confirmation for new branches and the default branch.
- Tool and model picker; settings for language, size limits, summary-only files and untracked files.
- English and Turkish.
