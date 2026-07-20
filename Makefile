SHELL := /bin/bash

UUID := pico-argos@jsnjack.github.io
SRC_DIR := $(UUID)
BUILD_DIR := build
DIST_DIR := dist
ESLINT := node_modules/.bin/eslint
SCHEMAS := $(wildcard $(SRC_DIR)/schemas/*.gschema.xml)
PACKAGE := $(DIST_DIR)/$(UUID).shell-extension.zip

.PHONY: check spec-check format-check lint test schemas package package-check install standards clean

check: spec-check format-check lint test package-check
	@echo "==> make check: all green"

spec-check:
	@test -s SPEC.md
	@rg -q '^Project name: `pico-argos`$$' SPEC.md
	@rg -q '^## 3\. Performance Contract$$' SPEC.md
	@rg -q '^## 8\. Universal Plugin Model$$' SPEC.md
	@rg -q '^## 12\. Diagnostics and Timing$$' SPEC.md
	@awk 'BEGIN { n = 0 } /^```/ { n++ } END { exit n % 2 }' SPEC.md

format-check:
	@! rg -n '[[:blank:]]+$$' --glob '*.md' --glob '*.js' --glob '*.json' --glob '*.xml' .

lint:
	@if [[ -f "$(SRC_DIR)/extension.js" ]]; then \
		[[ -x "$(ESLINT)" ]] || { \
			echo "Project development dependencies are missing. Install them with: npm install"; \
			exit 1; \
		}; \
		"$(ESLINT)" "$(SRC_DIR)" $(wildcard plugins tests); \
	else \
		echo "==> lint: extension source not present yet"; \
	fi

test:
	@set -e; \
	mapfile -t tests < <(find . -type f -name '*.test.js' -not -path './node_modules/*' | sort); \
	if (( $${#tests[@]} == 0 )); then \
		echo "==> test: no GJS tests yet"; \
	else \
		for test_file in "$${tests[@]}"; do gjs -m "$$test_file"; done; \
	fi

schemas:
	@rm -rf "$(BUILD_DIR)/$(UUID)"
	@mkdir -p "$(BUILD_DIR)/$(UUID)/lib" "$(BUILD_DIR)/$(UUID)/schemas"
	@cp "$(SRC_DIR)"/*.js "$(SRC_DIR)"/*.json "$(SRC_DIR)"/*.css "$(BUILD_DIR)/$(UUID)/"
	@find "$(SRC_DIR)/lib" -maxdepth 1 -type f -name '*.js' -not -name '*.test.js' \
		-exec cp {} "$(BUILD_DIR)/$(UUID)/lib/" \;
	@if compgen -G "$(SRC_DIR)/schemas/*.gschema.xml" >/dev/null; then \
		cp "$(SRC_DIR)"/schemas/*.gschema.xml "$(BUILD_DIR)/$(UUID)/schemas/"; \
		glib-compile-schemas --strict "$(BUILD_DIR)/$(UUID)/schemas"; \
	else \
		echo "==> schemas: no schemas yet"; \
	fi

package-check:
	@if [[ -f "$(SRC_DIR)/metadata.json" ]]; then \
		set -e; \
		$(MAKE) package; \
		test -s "$(BUILD_DIR)/$(UUID)/schemas/gschemas.compiled"; \
		unzip -Z1 "$(PACKAGE)" | rg -q '^lib/extension-controller\.js$$'; \
		unzip -Z1 "$(PACKAGE)" | rg -q '^schemas/org\.gnome\.shell\.extensions\.pico-argos\.gschema\.xml$$'; \
		! unzip -Z1 "$(PACKAGE)" | rg -q '^schemas/gschemas\.compiled$$'; \
		! unzip -Z1 "$(PACKAGE)" | rg -q '\.test\.js$$'; \
		! unzip -Z1 "$(PACKAGE)" | rg -q '^plugins/'; \
	else echo "==> package: extension source not present yet"; fi

package: schemas
	@mkdir -p "$(DIST_DIR)"
	@gnome-extensions pack --force --out-dir="$(DIST_DIR)" \
		--extra-source=lib --extra-source=schemas "$(BUILD_DIR)/$(UUID)"

install: package
	@gnome-extensions install --force "$(DIST_DIR)/$(UUID).shell-extension.zip"

standards:
	curl -sS --fail https://raw.githubusercontent.com/jsnjack/standards/master/AGENTS.universal.md -o AGENTS.universal.md
	curl -sS --fail https://raw.githubusercontent.com/jsnjack/standards/master/AGENTS.gjs.md -o AGENTS.gjs.md

clean:
	rm -rf "$(BUILD_DIR)" "$(DIST_DIR)"
