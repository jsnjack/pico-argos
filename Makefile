SHELL := /bin/bash

UUID := pico-argos@jsnjack.github.io
SRC_DIR := $(UUID)
BUILD_DIR := build
DIST_DIR := dist
SCHEMAS := $(wildcard $(SRC_DIR)/schemas/*.gschema.xml)
SCHEMA_ARGS := $(foreach schema,$(SCHEMAS),--schema=$(schema))

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
		command -v eslint >/dev/null 2>&1 || { \
			echo "eslint is not installed. Install the project development dependencies."; \
			exit 1; \
		}; \
		eslint "$(SRC_DIR)" $(wildcard plugins tests); \
	else \
		echo "==> lint: extension source not present yet"; \
	fi

test:
	@mapfile -t tests < <(find . -type f -name '*.test.js' -not -path './node_modules/*' | sort); \
	if (( $${#tests[@]} == 0 )); then \
		echo "==> test: no GJS tests yet"; \
	else \
		for test_file in "$${tests[@]}"; do gjs -m "$$test_file"; done; \
	fi

schemas:
	@mkdir -p "$(BUILD_DIR)/$(UUID)"
	@if compgen -G "$(SRC_DIR)/schemas/*.gschema.xml" >/dev/null; then \
		cp "$(SRC_DIR)"/schemas/*.gschema.xml "$(BUILD_DIR)/$(UUID)/"; \
		glib-compile-schemas --strict "$(BUILD_DIR)/$(UUID)"; \
	else \
		echo "==> schemas: no schemas yet"; \
	fi

package-check:
	@if [[ -f "$(SRC_DIR)/metadata.json" ]]; then $(MAKE) package; \
	else echo "==> package: extension source not present yet"; fi

package: schemas
	@mkdir -p "$(DIST_DIR)"
	@gnome-extensions pack --force --out-dir="$(DIST_DIR)" $(SCHEMA_ARGS) "$(SRC_DIR)"

install: package
	@gnome-extensions install --force "$(DIST_DIR)/$(UUID).shell-extension.zip"

standards:
	curl -sS --fail https://raw.githubusercontent.com/jsnjack/standards/master/AGENTS.universal.md -o AGENTS.universal.md
	curl -sS --fail https://raw.githubusercontent.com/jsnjack/standards/master/AGENTS.gjs.md -o AGENTS.gjs.md

clean:
	rm -rf "$(BUILD_DIR)" "$(DIST_DIR)"
