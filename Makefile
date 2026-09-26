SHELL := /bin/bash
.DEFAULT_GOAL := help

export INSTANCE_1_APP ?= $(HOME)/Applications/Splinter Cell Blacklist.app
export INSTANCE_2_APP ?= $(HOME)/Applications/Splinter Cell Blacklist 2.app
export RENDERER ?= dx11

.PHONY: help server instance-1 instance-2 instances

help:
	@printf '%s\n' \
	  'make server      Start the Bun server in this worktree' \
	  'make instance-1  Launch client 1 (sam_the_fisher in the current setup)' \
	  'make instance-2  Launch client 2 (archie in the current setup)' \
	  'make instances   Launch both clients side by side' \
	  '' \
	  'Start the server in another terminal before launching clients.' \
	  'Overrides: INSTANCE_1_APP, INSTANCE_2_APP, RENDERER=dx9' \
	  "Accounts come from each app bundle's uplay.toml."

server:
	cd bun-impl && bun run start

instance-1:
	SC6_APP="$$INSTANCE_1_APP" bash mac/launch.sh "$$RENDERER"

instance-2:
	SC6_APP="$$INSTANCE_2_APP" bash mac/launch.sh "$$RENDERER"

# Each launcher waits for its Wine prefix to exit, so run them concurrently.
instances:
	$(MAKE) --no-print-directory -j2 instance-1 instance-2
