# RFAM Dissertation Tracker

A single-file, GitHub-backed daily/weekly task tracker for the RFAM dissertation
(defense Oct 2026). Public app shell, **private task data**.

**Live app:** https://mattlmccoy.github.io/dissertation-tracker/

## How it works

- This repo holds only the app (`index.html`) and is served by **GitHub Pages** (free, public).
- Your actual tasks live in a **separate private repo** (`dissertation-tracker-data/tasks.json`),
  so the task list is **not** public even though the app shell is.
- The app reads and writes `tasks.json` directly via the GitHub API, using a token you paste
  once per browser. The token is stored only in this browser's `localStorage`, is sent only to
  `api.github.com`, and is **never committed** — there is no server.

## First-time setup (once per browser)

1. Open the live app.
2. Create a **fine-grained personal access token**: GitHub → Settings → Developer settings →
   Fine-grained tokens. Scope it to **only** the `dissertation-tracker-data` repository, with
   **Repository permissions → Contents: Read and write**.
3. Click the ⚙ gear in the app, paste the token, confirm the data repo is
   `mattlmccoy/dissertation-tracker-data/tasks.json`, and hit **Save & Pull**.

## Daily use

- **Today / This Week / Board** tabs. Today shows active, due, daily/weekly, and overdue items;
  Board shows everything grouped by phase with progress bars.
- Click a task to edit; click the checkbox to mark done; **+ Task** to add.
- The **Sync** button pulls when clean and pushes when you have unsaved edits
  (the dot turns amber and the label shows `Push*`). `Cmd/Ctrl-S` pushes.
- Edits are cached in `localStorage`, so the app works offline; sync when you're back online.

Phases: DoE & Validation, Papers, Novelty, Lab & Experiments, Dissertation.
