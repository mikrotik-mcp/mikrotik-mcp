---
title: "Files"
description: "The files of every router — search, upload, download, copy between routers"
---

## Open the files of a router

Open **Router configuration → Files** (`#files`). Click a router beside **Open files of**. Each router opens in its own pane, side by side. If the page shows **Files is turned off**, turn it on in **Config → Dashboard → Files page**: see [Turn it on or off](/docs/guides/files#turn-it-on-or-off).

## Move files

| To do this                      | Do this                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| Upload                          | Drop files from your computer on a pane or on a folder row.  |
| Download                        | Double-click a file, or select files and click **Download**. |
| Copy from one router to another | Drag files from one pane to another, or use **Copy to…**.    |

The **Transfers** list at the bottom shows the progress, speed and time left of each transfer. You can stop a transfer and try it again.

## Work with a file

Double-click a text file to read it; **Edit** saves it back to the router. **Compare** shows the differences between two files, also on two routers. Right-click a row for every action, including **Follow (live tail)** for a log and **Import…** for a `.rsc` file, which does a dry run first.

## The toolbar

| Button              | What it does                                                           |
| ------------------- | ---------------------------------------------------------------------- |
| **Compare folders** | The files of two open folders side by side; copy what is missing.      |
| **Vault**           | The backup vault of the server; send a saved file to a router.         |
| **Scheduled**       | Jobs that copy matching router files into the vault at an interval.    |
| **Bookmarks**       | Folders you marked with the star of a pane.                            |
| **Workspaces**      | Saved pane layouts.                                                    |
| **Recycle bin**     | Files the page deleted or replaced in the last 7 days; put one back.   |
| **Upload to all**   | An upload to one pane goes to every open router.                       |
| **Direct copy**     | The destination router fetches a large file from the source by itself. |
| **Verify**          | After a copy, compare the SHA-256 of the copy with the source.         |

The archive button of a pane makes a backup or an export on the router, and opens the storage analysis.

## Search

The search box searches every open router at once. **Contents** searches the text inside small text files. **Regex** reads the text as a regular expression. Click a result to show the file in the pane of its router.

## Before you change a router

- A name that is already in the folder asks before it is replaced.
- **Delete** asks first. Files up to 64 MiB stay in the recycle bin for 7 days.
- A stopped or failed upload leaves no partial file on the router.
- A read-only server lists, searches and downloads only.

See the [files guide](/docs/guides/files) for every feature, the limits and the API.
