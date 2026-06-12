# Screenwork

Screenwork is a small internal web app for collecting and developing screenshot ideas from short videos. It runs as a Docker service, stores image files on disk, and keeps metadata in SQLite.

## Features

- Mobile-friendly screenshot upload.
- Dedicated upload page at `/upload.html`, suitable for bookmarking on mobile.
- PNG uploads are converted to JPG with quality 80 before storage.
- Header with title, upload, status filter, and settings.
- Category menu with up to 3 levels.
- Work project menu for grouping tagged screenshots into development tasks.
- Image grid and detail editor.
- Title, note, status, category, and TAG marking.
- AI expansion through a local Metapi OpenAI-compatible or Claude-compatible API.
- Export selected screenshots as ZIP, Markdown, Excel, or Notion-style CSV.
- Local backup and restore from Settings, including SQLite data, uploads, thumbnails, and exports.
- No login or authentication.

## Local Run

```powershell
cd G:\code\screenwork
docker compose up --build
```

Open:

```text
http://localhost:26633
```

## Server Deployment

Target server directory:

```text
/home/cooper/screenwork
```

Run on the 3dprint server:

```bash
cd /home/cooper/screenwork
docker compose up -d --build
```

Access from the internal network:

```text
http://<3dprint-server-lan-ip>:26633
```

The port is intended for LAN access only. The external UFW firewall does not need to open `26633`.

## Metapi Configuration

Copy `.env.example` to `.env` if you want Docker Compose to load local Metapi settings:

```bash
cp .env.example .env
```

Common values:

```env
METAPI_BASE_URL=http://host.docker.internal:3000
METAPI_MODEL=gpt-4o-mini
METAPI_PROVIDER=openai
METAPI_API_KEY=
```

When Screenwork runs inside Docker and Metapi runs directly on the same Linux host, use `host.docker.internal` instead of `127.0.0.1`.

`METAPI_PROVIDER` supports:

- `openai`: calls `/v1/chat/completions`.
- `claude`: calls `/v1/messages`.

Settings can also be edited in the web UI. Environment variables take priority over UI settings.

## Data

Runtime data is stored under:

```text
./data
```

This folder contains uploads, thumbnails, exports, and the SQLite database. It is ignored by Git and should be backed up separately if needed.

## Backup and Restore

Open Settings in the web UI and use the Backup Restore section.

- `Create Backup` writes a ZIP file under `./data/backups`.
- Backup ZIP files include `screenwork.db`, `uploads/`, `thumbs/`, `exports/`, and `manifest.json`.
- Existing backups are not included inside new backups.
- Restore accepts a Screenwork backup ZIP and automatically creates a `screenwork-pre-restore-*.zip` safety backup before replacing current data.
- Restore validates ZIP paths and only restores supported Screenwork data paths.

## GitHub Sync

After the app has been verified, initialize Git and push to GitHub:

```powershell
cd G:\code\screenwork
git init
git add .
git commit -m "Initial Screenwork project"
git branch -M main
git remote add origin https://github.com/1azgit/Screenwork.git
git push -u origin main
```

If the remote already exists:

```powershell
git remote set-url origin https://github.com/1azgit/Screenwork.git
git push -u origin main
```

Before pushing, run `git status` and confirm that `.env`, `data/`, screenshots, databases, logs, and export files are not staged.
