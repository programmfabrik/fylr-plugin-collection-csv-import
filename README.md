# Collection CSV Import Plugin for Fylr

Server-side plugin that enables CSV import functionality through Fylr's hotfolder collection system. When a CSV file is uploaded to a configured hotfolder collection, this plugin automatically processes and imports the data using the CSV Importer.

## Features

- **Hotfolder Integration**: Automatically triggers CSV import when files are uploaded to configured collections
- **Daily Subcollections**: Imported objects are organized into daily subcollections (format: `DD-MM-YYYY`) under the hotfolder collection
- **Headless CSV Importer**: Runs the ez5 CSV Importer in headless mode on the server
- **Configurable Import Settings**: Uses the same CSV import configuration as the webfrontend importer
- **Debug Mode** (Only for development): Optional file logging to `/tmp/csv_import_debug.log` for troubleshooting

## Requirements

- Fylr server with Node.js service enabled
- CSV Importer plugin installed and configured in the webfrontend

## Installation

1. **Via URL (recommended):**
   - Use the following URL to install the plugin and **receive automatic updates** in your instance:
   - [https://github.com/programmfabrik/fylr-plugin-collection-csv-import/releases/download/latest/fylr-plugin-collection-csv-import.zip](https://github.com/programmfabrik/fylr-plugin-collection-csv-import/releases/download/latest/fylr-plugin-collection-csv-import.zip)

2. **Via ZIP:**
   - Download the latest version from the releases page
   - Use the Plugin Manager in Fylr to install the downloaded plugin package. Plugins installed via ZIP don't get updated automatically.

## Configuration

1. In fylr frontend, create or select a collection to use as a hotfolder and enter to collection settings
2. Enable the hotfolder functionality on the collection. This is required in order to be able to access the plugin's tab.
3. In the collection settings, enable **CSV Import** and configure the import settings
4.	You can now set up the CSV import parameters. The configuration module works exactly the same as the CSV importer.
5.	Once inside the configuration module, upload a reference CSV. This CSV file will only be used to configure the importer; its data will not be imported into the instance.
6.	Configure the CSV import as you would normally do in the frontend. See the CSV Importer documentation for more information.
7.	Once you finish the configuration, you can click Prepare. If there is any issue, the system will notify you so you can fix it.
8.	If everything is correct, you can confirm the configuration and you will exit the CSV configurator.
9.	You can now save the collection configuration. The collection will then be ready to receive CSVs and start importing.
## How It Works

1. A CSV file is uploaded to a hotfolder collection
2. Fylr triggers the plugin's `collection_upload` callback
3. The plugin:
   - Validates the file is a CSV
   - Creates or finds a daily subcollection (e.g., `02-12-2025`)
   - Initializes the fylr environment in headless mode
   - Runs the CSV Importer with the configured settings
   - Imports objects into the daily subcollection
4. Import results are logged and returned to Fylr
    5.	The CSV importer can also update existing objects; these will not be added to the daily collection if they were not already in it beforehand.


## Debug Mode ONLY FOR DEVELOPMENT

To enable debug logging, set `CSV_IMPORTER_DEBUG = true` in `server/collection/csv_import.js`. This will:
- Write detailed logs to `/tmp/csv_import_debug.log`
- Include timestamps, API calls, and error stack traces
- Help troubleshoot import issues through the headless frontend execution

## Build

Make targets:
- `make build` → Compiles and bundles the plugin using ncc
- `make google-csv` → Downloads localization CSV from Google Sheets
- `make all` → Runs both build and google-csv
- `make zip` → Builds and creates `collection-csv-import.zip` inside `build/`
- `make clean` → Removes the build directory

## Files & Structure

- `server/collection/csv_import.js`
  - Main plugin script that handles CSV import logic
  - Runs in Node.js with jsdom for DOM simulation
  - Uses ez5 headless mode for the CSV Importer
- `manifest.master.yml`
  - Plugin manifest defining the collection_upload callback
- `modules/easydb-webfrontend/`
  - Submodule containing ez5 headless build and dependencies
- `Makefile`
  - Build pipeline for bundling and packaging

## Technical Details

- The plugin uses `jsdom` to simulate a browser environment for fylr frontend
- `ncc` bundles all Node.js dependencies into a single file
- The ez5 session is initialized with the user's access token from the hotfolder upload
- Daily subcollections are created as `workfolder` type with both children and objects allowed

## Localization

Localization strings are managed via Google Sheets and downloaded during build:
- Sheet ID: `1Z3UPJ6XqLBp-P8SUf-ewq4osNJ3iZWKJB83tc6Wrfn0`
- Output: `l10n/collection-csv-import.csv`
