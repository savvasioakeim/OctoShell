# Changelog

What changed in each release. The app reads this file and shows it in
Settings, under System, next to the update button.

Format: one `## version (date)` heading per release, then one line per change,
each starting with `- `. Write what a person would notice, not what the commit
did. An `Unreleased` heading holds the changes that are in the code but not yet
in a release; it becomes the next version's heading when that release is cut.

## 0.4.1 (2026-10-31)

- Dictation in QA notes, and a point-and-capture button beside it: drag a box
  over what is wrong and it lands in the note with the shot attached, instead of
  describing a corner of the screen in words.
- Dictation asks for the language you choose rather than the one Windows is set
  to. An English Windows used to mean English recognition whatever you spoke, so
  a Greek sentence came back as English spelling of Greek sounds. The setting
  sits under Settings, Speech-to-text.
- The progress bar keeps pulsing while an agent waits on its last step. It went
  still at exactly the moment the run looked finished, so a run that was waiting
  for you read as a run that had died.
- The review agent checks what the code does rather than reading the diff: it
  works from the task's acceptance criteria, opens whole functions and their
  callers in risky places, and has to show where a finding bites before it
  reports it.
- Projects no longer come up red after an update or a restart. Closing the app
  ends every shell at once, which the app used to record as a shell that could
  not start, and then showed you that record the next morning. It no longer
  writes the note on a normal quit, and a project you have not worked in since
  opening the app reads as idle rather than as whatever it last did.
- Inline code inside a message is readable on every theme. It used to sit on the
  lightest surface on a dark theme and the darkest on a light one, which left it
  as grey on grey in Paper, Daylight and Sand.

## 0.4.0 (2026-10-12)

- Themes. Six palettes, three dark and three light: OctoShell, Slate and Ember,
  then Paper, Daylight and Sand. Each one sets the window, the code blocks and
  the terminal together.
- Light themes, which the app could not do before: every colour in it was
  written for a dark background, down to a couple of hundred text classes.
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
