# Changelog

What changed in each release. The app reads this file and shows it in
Settings, under System, next to the update button.

Format: one `## version (date)` heading per release, then one line per change,
each starting with `- `. Write what a person would notice, not what the commit
did. An `Unreleased` heading holds the changes that are in the code but not yet
in a release; it becomes the next version's heading when that release is cut.

## Unreleased

- Themes. The window takes its colours from a VS Code theme, the same file that
  colours the code blocks and the terminal, so OctoShell can look like the
  editor you already use. Every theme Shiki bundles is there, 44 dark and 21
  light, and the label says which is which.
- Interface size. One slider scales the whole window, not just the text.
- Column order. The three columns can be put in any order, so the orchestrator
  can sit on the left. Each panel remembers its own width wherever it is.
- The side panels can now be dragged much wider, which is the only way to make
  the agent feed in the middle narrow.
- The font setting now changes the whole interface. It used to reach only the
  terminal and the code blocks. The list also shows only the fonts your machine
  actually has, so choosing one can no longer do nothing.
- Notifications can be limited to agents only, to the orchestrator only, or
  turned off, instead of all or nothing.
- The taskbar icon shows what the orchestrator is doing, so a minimised window
  still tells you when it needs you.
- Opening the orchestrator returns to your last conversation instead of a blank
  one.

## 0.3.1 (2026-10-06)

- Agents ask before running a command. You see what is about to run and allow
  or refuse it.
- Deleting a worktree asks first.
- An agent profile can be applied to the projects that are already open, not
  only to new ones.
- Long agent output keeps its useful end rather than its beginning, so the
  result of a command is what survives the truncation.
- macOS builds are Apple Silicon only. Intel builds could not be produced:
  fastembed pulls in ONNX Runtime, which publishes no binary for Intel Macs.
- Cleared every open npm security advisory.

## 0.3.0 (2026-09-28)

- macOS support. The app builds and runs on Apple Silicon, and the builds are
  signed with the updater key so the in-app updater accepts them.
- Codex runs on the maintained ACP adapter and takes a model and a reasoning
  effort like the others.
- Agents can run dev servers and keep them managed, so a server started for a
  task is stopped with it.
- A QA window of its own, and a task journal agents write to.
- The app opens on an empty workspace instead of a terminal in your home
  folder, and the orchestrator runs in a folder of its own.
- A dev server taking over a busy port no longer freezes the window.
- Child processes are cleaned up on SIGTERM as well as on a normal quit.
- Terminal fixes: every terminal gets its first prompt back, `ls` keeps its
  columns apart, and zsh's trailing marker is gone from command blocks.

## 0.2.0 (2026-09-11)

- In-app updates. The app checks GitHub for a new release, verifies the
  download against a signing key built into it, and installs it.
- The orchestrator can be reached from a phone.
- An agent says which skills it has, and the window says what the machine is
  doing.
- A project's pull request opens from the right-click menu.
- Background work stopped flashing terminal windows across the screen, and the
  pull request state is only polled while you are looking at the app.
