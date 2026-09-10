# server-access-manager

## Run Normally

1. Open terminal in this folder.
2. Run `run-server-access-manager.bat`.

The app is bound to localhost only.
Default mode is HTTP (`http://127.0.0.1:4173`).
Data is stored in `data/server-access-items.json` inside this folder.
After vault unlock, the file is saved as encrypted payload (`sam-storage-v1`).

## Run HTTPS In Internal Network (Private Certificate)

Use this mode when clients connect from other PCs and browser local file APIs must work in secure context.

1. Generate internal certificate files on server PC:
	`npm run cert:generate:internal`

2. Install root CA cert to trusted root on every client PC:
	`npm run cert:trust:internal`

3. Start HTTPS server on server PC:
	`npm run start:https`

	Or run batch mode:
	`run-server-access-manager.bat --https`

4. Access from client PC using HTTPS URL:
	`https://<server-host-or-ip>:4173`

5. Stop or restart server with npm commands:
	`npm run stop:server`
	`npm run restart:https`

Notes:

1. Generated files are placed in `.certs/`.
2. Default PFX password is `changeit`.
3. To override PFX password at runtime, set env var `SAM_PFX_PASS`.
4. Include real server host/IP in certificate SAN values when generating certs for production-like tests.

## Make Portable Offline Folder

Run once on a PC where Node.js is installed:

1. `prepare-offline-package.bat`

What this does:

1. Ensures `node_modules` exists (`npm ci` if needed).
2. Builds `dist` output for local runtime.
3. Copies local Node runtime into `.runtime/node`.

After this, you can copy this folder to another PC and run:

1. `run-server-access-manager.bat`

No global Node/npm is required on the target PC when `.runtime/node` and `dist` are included.

## Make Offline EXE Package (Windows)

Use this when you want to deploy to an offline PC as an executable package.

On a build PC with Node.js:

1. `prepare-offline-exe-package.bat`

This creates `offline-exe/` with:

1. `server-access-manager.exe` (local file server executable)
2. `dist/` (frontend build output)
3. `run-server-access-manager-exe.bat` (launcher)
4. Optional `.certs/sam-server.pfx` (if present in source folder)

On the offline target PC:

1. Copy `offline-exe/` folder.
2. Run `run-server-access-manager-exe.bat` for default localhost HTTP mode.
3. Run `run-server-access-manager-exe.bat --https` for HTTPS mode.

Notes:

1. First EXE build may require internet to download pkg base runtime on build PC.
2. Runtime on target PC does not need Node.js/npm.
