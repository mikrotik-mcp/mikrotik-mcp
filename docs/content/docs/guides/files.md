---
title: Dashboard files
description: The files of every router in the browser — side-by-side panes, search on all routers, drag-and-drop upload and download with progress, and router-to-router copy.
---

The **Files** page of the [dashboard](/docs/guides/observability) shows the files of your routers, as the Files window of WinBox does. You open one pane for each router, side by side, and move files between your computer and the routers, or from one router to another.

## Turn it on

The page reads and writes files on your routers, and files can hold secrets (backups, exports, keys). It is served only when one of these is true:

- the dashboard has a token (`--dashboard-token`), or
- the dashboard listens on loopback (`--dashboard-host 127.0.0.1`).

If not, the page shows **Files is locked**. To turn the page off, set `--dashboard-files=false` (`MIKROTIK_DASHBOARD__FILES=false`).

| Server mode            | What the page can do                                  |
| ---------------------- | ----------------------------------------------------- |
| Default                | Everything on this page.                              |
| Read-only (`readOnly`) | List, search and download. No upload, copy or delete. |

A router that is reached over MAC-Telnet has no file transfer, so its pane shows an error. Configure SSH for that router.

## Panes

Click a router beside **Open files of** to open a pane for it. On the first visit, the page opens the first three routers side by side.

- Drag a pane tab to split, stack or float the pane. Drag a border to resize it. Right-click a tab to rename the pane or give it a colour.
- You can open several panes for one router, each on a different folder.
- The layout and the folder of each pane are kept in the browser.

Each pane shows:

- the folder path — click a part of the path to go there;
- the storage of the router: free space and total space;
- the files of the folder, with size and time of change. Click a column name to sort. **Filter this folder** hides the names that do not match.

Double-click a folder to open it. Double-click a file to download it.

### Keys

| Key                  | Action                       |
| -------------------- | ---------------------------- |
| Click                | Select one row.              |
| `Ctrl`/`Cmd` + click | Add or remove a row.         |
| `Shift` + click      | Select a range.              |
| `Ctrl`/`Cmd` + `A`   | Select all rows.             |
| `Enter`              | Open the folder or download. |
| `F2`                 | Rename.                      |
| `Delete`             | Delete (asks first).         |
| `Esc`                | Clear the selection.         |

## Upload

Drop files from your computer on a pane to upload them to the open folder. Drop them on a folder row to upload into that folder. The **Upload** button opens the file picker.

- If a name is already in the folder, the pane asks: **Replace**, **Skip these** or **Cancel**.
- If an upload fails or you stop it, the server removes the partial file from the router. Half of a package or a backup is worse than none.
- Folders are not uploaded. Drop the files of the folder.
- One upload can be up to 1 GiB.

## Download

Select files and click **Download**, or double-click a file. The browser saves each file when its transfer is complete.

## Copy between routers

Drag files from the pane of one router and drop them on the pane of another router (or on a folder row). You can also select files and choose the destination under **Copy to…**, which lists the other open panes.

The server relays the copy: it reads the file from the source router and writes it to the destination router as one stream.

- The two routers do not need to reach each other. Only the server must reach both.
- Neither router learns the credentials of the other.
- Nothing is stored on the server.
- A copy to another folder of the same router works the same way.

Folders are not copied; only files.

## Transfers

Every upload, download and copy goes into one queue at the bottom of the page. Three transfers run at the same time; the others wait.

Each transfer shows its progress, speed and time left. You can stop a transfer, and try a stopped or failed transfer again. **Clear finished** removes the completed rows.

## Search

The search box searches every open router at the same time, from the root folder.

| Option       | What it searches                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------- |
| (default)    | File and folder names.                                                                              |
| **Contents** | The text inside text files (`.rsc`, `.txt`, `.log`, `.conf`, `.json` and similar) up to 1 MiB each. |
| **Regex**    | The search text is a regular expression. Case is ignored.                                           |

Results arrive while the search runs, in a list for each router. Click a result to open its folder in the pane of that router and select the file.

A search stops early on a router after 4000 files and folders, 8 folder levels, or 500 results. The list then shows **stopped early**.

## Rename, new folder, delete

Select one row and click **Rename**, or press `F2`. The **new folder** button makes a folder in the open folder. **Delete** asks first, and cannot be undone. A folder must be empty before you delete it.

## What is recorded

Every upload, download, copy, rename, new folder and delete is written to the audit feed as the tool `dashboard_files`, with the router, the path and the result. File contents are not recorded.

## How it works

All file operations use SFTP, the file subsystem of the RouterOS SSH server. The server keeps one SFTP session for each router while the page is in use, and closes it after one minute without use. The SSH user of the router needs the `ftp` policy, and the `sensitive` policy to read backup files.

## API

All routes need the dashboard token when one is set.

| Route                      | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `GET /api/files/state`     | Whether the page is available, and whether it is read-only. |
| `GET /api/files/list`      | The entries of one folder (`device`, `path`).               |
| `GET /api/files/usage`     | Free and total storage of a router.                         |
| `GET /api/files/download`  | The bytes of one file.                                      |
| `POST /api/files/search`   | Search on several routers; the answer is NDJSON.            |
| `POST /api/files/upload`   | The request body becomes the file (`device`, `path`).       |
| `POST /api/files/transfer` | Copy a file between routers; progress is NDJSON.            |
| `POST /api/files/rename`   | Rename or move a file on one router.                        |
| `POST /api/files/mkdir`    | Make a folder.                                              |
| `POST /api/files/delete`   | Delete files or empty folders.                              |
