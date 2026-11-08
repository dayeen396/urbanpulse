# Infrastructure

The root `docker-compose.yml` owns the local service topology. PostgreSQL schema migrations live beside the API in `apps/api/migrations` and are applied by the Compose `migrate` service. The environment-driven administrator seed command is `npm run seed` in the API workspace.
