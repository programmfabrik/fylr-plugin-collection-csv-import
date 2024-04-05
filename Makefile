PLUGIN_NAME = collection-csv-import
ZIP_NAME ?= $(PLUGIN_NAME).zip
BUILD_DIR = build

# config for Google CSV spreadsheet
L10N_DIR = $(BUILD_DIR)/$(PLUGIN_NAME)/l10n
L10N = $(L10N_DIR)/$(PLUGIN_NAME).csv
GKEY = 1Z3UPJ6XqLBp-P8SUf-ewq4osNJ3iZWKJB83tc6Wrfn0
GID_LOCA = 2098969173
GOOGLE_URL = https://docs.google.com/spreadsheets/u/1/d/$(GKEY)/export?format=csv&gid=

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

all: build google-csv ## build all

google-csv: ## get loca CSV from google
	mkdir -p $(L10N_DIR)
	curl --silent -L -o - "$(GOOGLE_URL)$(GID_LOCA)" | tr -d "\r" > $(L10N)

build: clean ## copy files to build folder
	mkdir -p $(BUILD_DIR)/$(PLUGIN_NAME)
	cp -r server $(BUILD_DIR)/$(PLUGIN_NAME)
	cp -r manifest.master.yml $(BUILD_DIR)/$(PLUGIN_NAME)/manifest.yml

clean: ## clean
	rm -rf $(BUILD_DIR)

zip: build ## build zip file
	cd build && zip ${ZIP_NAME} -r $(PLUGIN_NAME)/