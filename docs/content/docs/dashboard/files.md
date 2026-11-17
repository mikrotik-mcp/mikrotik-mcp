---
title: "Files"
description: "The files of every router — search, upload, download, copy between routers"
---

## Open the files of a router

Open **Router configuration → Files** (`#files`). Click a router beside **Open files of**. Each router opens in its own pane, side by side. If the page shows **Files is locked**, the dashboard has no token and does not listen on loopback: see [Turn it on](/docs/guides/files#turn-it-on).

## Move files

| To do this                      | Do this                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| Upload                          | Drop files from your computer on a pane or on a folder row.  |
| Download                        | Double-click a file, or select files and click **Download**. |
| Copy from one router to another | Drag files from one pane to another, or use **Copy to…**.    |

The **Transfers** list at the bottom shows the progress, speed and time left of each transfer. You can stop a transfer and try it again.

## Search

The search box searches every open router at once. **Contents** searches the text inside small text files. **Regex** reads the text as a regular expression. Click a result to show the file in the pane of its router.

## Before you change a router

- A name that is already in the folder asks before it is replaced.
- **Delete** asks first and cannot be undone.
- A stopped or failed upload leaves no partial file on the router.
- A read-only server lists, searches and downloads only.

See the [files guide](/docs/guides/files) for every feature, the limits and the API.
