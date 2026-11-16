# File memory

Memory is a small, durable tree of validated markdown files stored in the same
database as the rest of the app. It is not a sandbox VM filesystem, a vector
store, or a remote memory service. The pure path/operation primitives live in
`apps/web/lib/server/memory-files.ts`; the identity-aware adapter lives in
`apps/web/lib/server/memory.ts`; persistence is `AppStore.memory`.

## Shape

```text
instructions.md   user-confirmed instructions (global, trusted, read-only to the model)
index.md          assistant-maintained index of the archive
reported.md       run-completion metadata written by the system
notes/<name>.md   lazily browsed assistant notes
progress/<name>.md lazily browsed progress notes
```

Paths are relative, forward-slash only, one branch deep, and end in `.md`.
Absolute paths, drive/UNC prefixes, backslashes, traversal segments, glob
characters, dotfiles, device names, and non-markdown files are rejected.
`toMemoryName` sanitizes arbitrary text into a safe name while preserving
unicode letters and numbers.

Each entry carries `path`, `content`, `version`, `source`, `provenance`,
`sourceRunId`, `createdAt`, and `updatedAt`. `version` is the revision the
durable adapter compare-and-swaps against.

## Scope and identity

- `instructions.md` is global to one user. It is stored with empty
  `conversationId`/`botId`.
- `index.md`, `reported.md`, `notes/*.md`, and `progress/*.md` are bound to one
  bot in one conversation.
- The unique key is `(userId, conversationId, botId, path)`.
- The adapter derives the scope from the authenticated user plus a conversation
  and bot that the store confirms belong to that user. A model tool never
  supplies a raw user id, and a path in another scope is simply not found.

## Always-loaded core

`buildCoreContext` loads only `instructions.md`, `index.md`, and `reported.md`
at run start. It applies a per-file cap and a total character budget
(`DEFAULT_CORE_LIMITS`: 2,500 characters per file and 6,000 characters total),
reports missing files instead of throwing, and returns a prompt section that
separates trusted user-confirmed instructions from assistant memory data. Notes
and progress are never preloaded.

## Lazy browsing

`listMemoryDirectory` returns names, kinds, sizes, versions, and timestamps
without content. `readMemoryFile` reads one file with optional 1-based line
ranges and a character cap. `exportMemorySnapshot` returns a sorted full
snapshot for the user-facing export.

## Operations

`planMemoryOperation` validates a memory-tool style request and computes the
exact proposed content or path change:

- `create` — new path, `expectedVersion: null`.
- `str_replace` — exactly one exact match; zero or multiple matches are
  rejected.
- `insert` — insert content at a chosen 1-based line.
- `delete` — remove a path.
- `rename` — move a path; the destination must not exist.

Every mutation carries `expectedVersion`. `applyMemoryPlan` is a deterministic
reference implementation; the durable adapter enforces the same
compare-and-swap atomically (a Postgres transaction or the file store's
copy-on-write commit).

`planMemoryWrite` is the whole-file variant used by the user instructions
editor and by system run-completion metadata.

## Write policy

Policy is enforced in code, not only in the prompt:

- The model may write `notes/*.md`, `progress/*.md`, and `index.md`.
- The model may never write `instructions.md`.
- Only user- or system-sourced writes may change `instructions.md`.
- `reported.md` is written only by the system as run-completion metadata.
- Tool and web content can never be persisted as instructions.

## Native tools

- `memory_view` lists the directory or reads one file.
- `memory_create`, `memory_str_replace`, `memory_insert`, and `memory_rename`
  mutate notes, progress, or the index.
- `memory_delete` requires explicit user approval and resumes through the
  existing durable approval path.

All tool input is validated at runtime. Tool and web content is data, never a
trusted instruction; the model is told to store short pointers rather than copy
whole records into the directory.

## Scheduled runs

A scheduled run loads the same core, including the last `reported.md`. When it
completes with a message, the system writes `reported.md` with a run pointer and
a content hash. If a later scheduled result is byte-equal to the prior report,
the run succeeds silently and records a `report_suppressed` event instead of
emitting a duplicate message. A `NO_REPLY` run writes no report.

## User API

All routes authenticate with the normal session and return local verified
state; there is no asynchronous external memory service. The web **Memory**
settings tab uses these routes to edit instructions, browse files, export a
snapshot, and forget explicit paths.

- `GET /api/memory?conversationId=&botId=` — directory plus global
  instructions. Without a scope it returns instructions and the user's
  permitted conversation scopes.
- `GET /api/memory/file?conversationId=&botId=&path=` — one file.
- `PATCH /api/memory/instructions` — replace global instructions with an
  expected revision; a mismatch is a conflict.
- `GET /api/memory/export?conversationId=&botId=` — full JSON snapshot.
- `POST /api/memory/forget` — explicit path-scoped deletion. Global
  instructions are never deleted here.

## Secret policy

`scanForSecrets` rejects convincing high-confidence shapes before persistence:
PEM private keys, environment/API-key assignments, explicit bearer/OAuth
tokens, database URLs with embedded credentials, and AWS access keys. This is a
best-effort check and does not claim to catch every secret. Normal technical
text that merely names an environment variable is preserved.

## Limits

- `MAX_MEMORY_FILE_CHARS` bounds a single file.
- `MAX_MEMORY_DIRECTORY_ENTRIES` bounds a directory listing.
- `MAX_MEMORY_NAME_LENGTH` and `MAX_MEMORY_PATH_LENGTH` bound names and paths.
- Content must be text; NUL and other binary control characters are rejected.

There is no semantic vector store, remote memory service, automatic
consolidation, or background "dreaming" in this model.
