include .env

# =================================================================
# HELP
# =================================================================

## help : print this help message
.PHONY: help
help:
	@echo 'Usage:'
	@sed -n 's/^##//p' $(MAKEFILE_LIST) | column -t -s ':' | sed -e 's/^/ /'

.PHONY: confirm
confirm:
	@echo -n 'Are you sure? (y/n): ' && read ans && [ $${ans:-N} = y ]


# =================================================================
# INFRASTRUCTURE — multi-service orchestration
# =================================================================

## infra/start : start the database containers and wait until they are ready
.PHONY: infra/start
infra/start:
	docker compose up -d
	@echo "Waiting for Postgres..."
	@until docker compose exec postgres pg_isready -U agentgate > /dev/null 2>&1; do sleep 0.5; done
	@echo "Waiting for Redis..."
	@until docker compose exec redis redis-cli ping > /dev/null 2>&1; do sleep 0.5; done
	@echo "Stack ready."

## infra/stop : stop all containers (volumes preserved)
.PHONY: infra/stop
infra/stop:
	docker compose down

## infra/status : show container health status
.PHONY: infra/status
infra/status:
	docker compose ps

## infra/reset : wipe all data and restart from scratch (requires confirm)
.PHONY: infra/reset
infra/reset: confirm
	docker compose down -v
	docker compose up -d
	@until docker compose exec db pg_isready -U agentgate > /dev/null 2>&1; do sleep 0.5; done
	@until docker compose exec redis redis-cli ping > /dev/null 2>&1; do sleep 0.5; done
	@echo "Stack reset. Run 'make db/migrate' to reapply migrations."

## infra/destroy : stop containers and permanently delete all volume data (requires confirm)
.PHONY: infra/destroy
infra/destroy: confirm
	docker compose down -v
	@echo "All data destroyed."


# =================================================================
# POSTGRES
# =================================================================

## db/psql : open an interactive psql session in the running container
.PHONY: db/psql
db/psql:
	docker compose exec postgres psql -U postgres -d agentgate

## db/logs : tail the postgres container logs
.PHONY: db/logs
db/logs:
	docker compose logs -f db

## db/migrate : create and apply a new migration (dev mode — prompts for migration name)
.PHONY: db/migrate
db/migrate:
	npx prisma migrate dev

## db/migrate/deploy : apply all pending migrations without prompts (CI / production)
.PHONY: db/migrate/deploy
db/migrate/deploy:
	npx prisma migrate deploy

## db/migrate/status : show which migrations are applied and which are pending
.PHONY: db/migrate/status
db/migrate/status:
	npx prisma migrate status

## db/studio : open Prisma Studio in the browser (visual table inspector and editor)
.PHONY: db/studio
db/studio:
	npx prisma studio


# =================================================================
# REDIS
# =================================================================

## redis/cli : open an interactive redis-cli session in the running container
.PHONY: redis/cli
redis/cli:
	docker compose exec redis redis-cli

## redis/monitor : stream every Redis command in real-time (dev debugging)
.PHONY: redis/monitor
redis/monitor:
	docker compose exec redis redis-cli monitor

## redis/keys : list all keys currently in Redis (dev inspection only)
.PHONY: redis/keys
redis/keys:
	docker compose exec redis redis-cli keys '*'

## redis/logs : tail the redis container logs
.PHONY: redis/logs
redis/logs:
	docker compose logs -f redis

## redis/flush : delete ALL Redis data — wipes rate counters and BullMQ jobs (requires confirm)
.PHONY: redis/flush
redis/flush: confirm
	docker compose exec redis redis-cli flushall
	@echo "Redis flushed."


# =================================================================
# DEVELOPMENT
# =================================================================

## dev : start the development server with ts-node
.PHONY: dev
dev:
	npm run dev

## test : run the full vitest test suite
.PHONY: test
test:
	npm test

## test/watch : run vitest in watch mode
.PHONY: test/watch
test/watch:
	npx vitest --watch

## build : typecheck and compile TypeScript to dist/
.PHONY: build
build:
	npx tsc --noEmit && npx tsc