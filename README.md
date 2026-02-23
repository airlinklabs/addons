# AirLink Addon Registry — Specification

The `airlinklabs/addons` repository is the central registry for community addons.
Each top-level folder is one addon. The folder name is the **unique addon ID** and must be lowercase with hyphens (e.g. `modrinth-store`, `parachute`).

---

## Folder Structure

```
airlinklabs/addons/
├── modrinth-store/
│   ├── info.json    ← required: metadata, icon, tags, features
│   └── install.json    ← required: install steps & commands
│
├── parachute/
│   ├── info.json
│   └── install.json
│
└── your-addon/
    ├── info.json
    └── install.json
```

---

## `info.json` Schema

```json
{
  "name": "Display Name",
  "version": "1.0.0",
  "description": "Short one-line description shown on cards.",
  "longDescription": "Longer paragraph shown in the detail popup. Optional — falls back to description.",
  "author": "your-github-username",
  "status": "working",
  "tags": ["Minecraft", "Backups"],
  "icon": "https://example.com/icon.svg",
  "iconType": "url",
  "features": [
    "Feature one",
    "Feature two"
  ],
  "github": "https://github.com/you/your-addon-repo",
  "screenshots": [],
  "installNote": "Optional tip shown below install steps."
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Display name |
| `version` | string | ✅ | Semver e.g. `1.2.3` |
| `description` | string | ✅ | Short description (1–2 sentences) |
| `longDescription` | string | — | Longer description for detail popup |
| `author` | string | ✅ | GitHub username or display name |
| `status` | `"working"` \| `"beta"` \| `"wip"` | — | Default: `"working"` |
| `tags` | string[] | — | Filter tags e.g. `["Minecraft", "API"]` |
| `icon` | string | — | URL to an SVG, PNG, or WEBP icon |
| `iconType` | `"url"` \| `"svg"` | — | `"url"` = img src, `"svg"` = inline svg string. Default: `"url"` |
| `features` | string[] | — | Bullet points shown in the detail popup |
| `github` | string | — | Link to your addon's source repo |
| `screenshots` | string[] | — | Array of direct image URLs |
| `installNote` | string | — | Warning/tip shown after install steps |

---

## `install.json` Schema

```json
{
  "note": "Optional note shown at the bottom of install steps.",
  "steps": [
    {
      "title": "Clone the addon",
      "commands": [
        "cd /var/www/panel/storage/addons/",
        "git clone https://github.com/you/your-addon.git your-addon"
      ]
    },
    {
      "title": "Install dependencies",
      "commands": [
        "cd /var/www/panel/storage/addons/your-addon",
        "npm install",
        "npm run build"
      ]
    },
    {
      "title": "Restart AirLink panel",
      "commands": [
        "systemctl restart airlink-panel"
      ]
    }
  ]
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `note` | string | — | Warning/note shown below all steps |
| `steps` | Step[] | ✅ | Ordered list of install steps |
| `steps[].title` | string | ✅ | Step heading |
| `steps[].commands` | string[] | ✅ | Shell commands to run |

---

## How the Registry Works

1. The GitHub Actions workflow in `airlinklabs/panel-docs` runs every 6 hours
2. It fetches the `airlinklabs/addons` repo contents via the GitHub API
3. For each folder, it reads `info.json` and `install.json`
4. It builds a single `public/api-cache/addons-registry.json` file
5. That file is committed and served statically — the site reads it at load time

This means your addon appears within 6 hours of being merged (or on the next manual workflow run).

---

## Submitting Your Addon

1. Fork `airlinklabs/addons`
2. Create a folder: `your-addon-id/` (unique, lowercase, hyphens only)
3. Add `info.json` and `install.json` following the schemas above
4. Open a Pull Request
5. Once merged, the registry auto-updates ✅
