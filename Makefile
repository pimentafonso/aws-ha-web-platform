ENV ?= dev

.PHONY: help lint deploy destroy

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

lint: ## Validate and scan all CloudFormation templates
	bash scripts/lint.sh

deploy: ## Deploy all stacks for ENV (dev|prod)
	bash scripts/deploy.sh $(ENV)

destroy: ## Delete all stacks for ENV (dev|prod), in reverse order
	bash scripts/destroy.sh $(ENV)
