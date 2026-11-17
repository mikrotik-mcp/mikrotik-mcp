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

- Drop a folder to upload its files into the same folder structure. The server makes the folders that do not exist.
- If a name is already in the folder, the pane asks: **Replace**, **Skip these** or **Cancel**.
- If an upload fails or you stop it, the server removes the partial file from the router. Half of a package or a backup is worse than none.
- One upload can be up to 1 GiB.

### Upload to all routers

Turn on **Upload to all** in the toolbar. A file that you drop on one pane then goes to the same folder on every router that has a pane open. Each router has its own row in the transfer list.

### Package check

Before a `.npk` file is uploaded, the pane compares the file name with the router: a package for another architecture, or an extra package of another RouterOS version, is reported with **Upload anyway** and **Cancel**. The pane shows the architecture and the version of its router beside the storage bar.

## Download

Select files and click **Download**, or double-click a file. The browser saves each file when its transfer is complete. A retried download continues at the byte where it stopped.

**ZIP** downloads a selection of several files or folders as one archive. The files are stored, not compressed. A selection can be up to 2 GiB.

## Copy between routers

Drag files or folders from the pane of one router and drop them on the pane of another router (or on a folder row). You can also select files and choose the destination under **Copy to…**, which lists the other open panes.

The server relays the copy: it reads the file from the source router and writes it to the destination router as one stream.

- The two routers do not need to reach each other. Only the server must reach both.
- Neither router learns the credentials of the other.
- Nothing is stored on the server.
- A copy to another folder of the same router works the same way.

### Large files

A copy larger than 8 MiB is written to `<name>.part` and renamed when it is complete. If the copy fails or you stop it, the `.part` file stays, and **Try again** continues from it.

### Checksum and Verify

Each relayed copy shows the SHA-256 of the bytes that passed. With **Verify** on in the toolbar, the server also reads the copy back from the destination and compares its SHA-256 with the source; a difference fails the transfer.

**Checksum** on one selected file shows its SHA-256 and copies it.

### Direct copy

With **Direct copy** on in the toolbar, the destination router fetches the file from the source by itself (`/tool fetch mode=sftp`), so the bytes do not pass through the server. Use it for a large file between routers that reach each other.

- The destination router gets the SSH password of the source router for that one command. Turn it on only when you accept that.
- It is used only when the source router has an IP address and a password in the config, and no jump host.
- In every other case, and when the fetch fails, the server relays the copy. The transfer row says which way the copy went.

## Compare folders

**Compare folders** shows the files of the open folders of two panes side by side: only left, only right, different size, or same. Copy one file in either direction, or every missing file in one step. Folders inside the two folders are left out.

## View, edit and compare files

Double-click a text file (`.rsc`, `.txt`, `.log`, `.conf`, `.json` and similar, up to 1 MiB) to read it. A `.rsc` file has the syntax colours of the [Terminal](/docs/guides/terminal). **Edit** changes the text, and **Save to router** writes it back.

**Compare** picks a file. A second pick, in any pane and on any router, opens the differences between the two files. Two selected files in one pane compare at once.

**Follow (live tail)** in the right-click menu of a text file shows the end of the file, then each addition as the router writes it, for up to 30 minutes. Use it for a log that RouterOS writes to disk.

## Backup, export and import

The archive button of a pane has **Backup now** (`/system backup save`) and **Export now** (`/export file=`). The router makes the file, and it shows in the root folder.

**Import…** on a `.rsc` file runs the script on its router:

1. The router does a dry run (`/import … dry-run`). It reports the errors and changes nothing.
2. **Run the import…**, then **Yes, change _router_**, runs the script.

## Recycle bin

Before the page deletes a file or replaces it (upload, copy, edit, restore), the server keeps a copy. The **Recycle bin** lists these files and puts a file back where it was.

- Files up to 64 MiB are kept, for 7 days, on the server beside the dashboard database (`files-trash/`).
- A larger file is not kept. The delete confirmation says what is kept.
- With `--dashboard-db=:memory:` there is no recycle bin.

## Vault and S3

**Vault** on selected files copies them into the backup vault of the server (the folder of the [Backups](/docs/dashboard/backups) page), as `<router>_<file>`. With S3 configured, **S3** also writes them to the bucket. One file can be up to 256 MiB.

The **Vault** button in the toolbar lists the vault. **Send** copies a file from the vault to the open folder of the pane you choose.

Saving to the vault reads the router only, so a read-only server can do it.

## Scheduled collection

**Scheduled** makes jobs that run on the server, also with no browser open. A job copies the files of one router folder that match a regular expression into the vault:

| Field           | Meaning                                                          |
| --------------- | ---------------------------------------------------------------- |
| Routers         | The routers to read. None selected means every router.           |
| Folder          | The folder to read. Folders inside it are not read.              |
| File names      | A regular expression, for example `\.backup$`.                   |
| Interval        | 6 hours, 12 hours, one day or one week. The minimum is one hour. |
| Keep the newest | How many collected files to keep for each router. `0` keeps all. |

A file that the vault already has, with the same size, is not copied again. A job removes only the files that it collected itself. There can be 20 jobs.

## Storage analysis

**Analyse the storage** in the archive menu of a pane reads every folder of the router and shows:

- the space of each top folder;
- the 15 largest files;
- files that are usually safe to remove: support output files (`autosupout*.rif`), backups older than 30 days after the newest three of each folder, and unfinished copies (`.part`).

Select files and delete them in one step.

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

Select one row and click **Rename**, or press `F2`. The **new folder** button makes a folder in the open folder. **Delete** asks first. A folder is deleted with everything in it.

## Row menu, bookmarks and workspaces

Right-click a row for its actions: open or view, download, compare, follow, copy the path, copy the import command, import, rename and delete.

The star of a pane bookmarks its folder. **Bookmarks** in the toolbar opens a bookmarked folder again. **Workspaces** saves the pane layout under a name. Bookmarks and workspaces are kept in the browser.

## What is recorded

Every upload, download, copy, read, rename, new folder, delete, backup, export, import and restore is written to the audit feed as the tool `dashboard_files`, with the router, the path and the result. File contents are not recorded. The password that a direct copy uses is not recorded.

## How it works

All file operations use SFTP, the file subsystem of the RouterOS SSH server. The server keeps one SFTP session for each router while the page is in use, and closes it after one minute without use. The SSH user of the router needs the `ftp` policy, and the `sensitive` policy to read backup files.

## API

All routes need the dashboard token when one is set.

| Route                      | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `GET /api/files/state`     | Whether the page is available, read-only, and what is on. |
| `GET /api/files/list`      | The entries of one folder (`device`, `path`).             |
| `GET /api/files/tree`      | Every file below a folder.                                |
| `GET /api/files/usage`     | Storage, architecture and version of a router.            |
| `GET /api/files/read`      | The text of a small file.                                 |
| `GET /api/files/hash`      | The SHA-256 of a file.                                    |
| `GET /api/files/tail`      | The end of a file, then what is added (a stream).         |
| `GET /api/files/download`  | The bytes of one file (`offset` continues a download).    |
| `GET /api/files/zip`       | Several `path` values as one ZIP archive.                 |
| `POST /api/files/search`   | Search on several routers; the answer is NDJSON.          |
| `POST /api/files/upload`   | The request body becomes the file (`device`, `path`).     |
| `POST /api/files/transfer` | Copy a file between routers; progress is NDJSON.          |
| `POST /api/files/make`     | Have the router make a backup or an export.               |
| `POST /api/files/import`   | Run a `.rsc` file; a dry run unless `dryRun` is `false`.  |
| `POST /api/files/rename`   | Rename or move a file on one router.                      |
| `POST /api/files/mkdir`    | Make a folder.                                            |
| `POST /api/files/delete`   | Delete files and folders.                                 |
| `GET /api/files/trash`     | The recycle bin. `…/restore` and `…/purge` change it.     |
| `GET /api/files/vault`     | The vault. `…/save` and `…/send` copy to and from it.     |
| `GET /api/files/jobs`      | Scheduled jobs. `POST` adds one; `…/run`, `…/remove`.     |
