.PHONY: up down logs migrate seed test lint build

up:
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

migrate:
	docker compose run --rm migrate

seed:
	docker compose exec api npm run seed

test:
	npm test

lint:
	npm run lint

build:
	npm run build
