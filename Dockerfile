FROM node:20-alpine
# git + CA certs: the native ingestion engine (POST /ingest, internal scheduler)
# clones/updates source repos directly, so the standalone container needs a git
# client and root certificates for https remotes.
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 7100
# Run migrations (idempotent, advisory-locked) then start. Migrations are skipped
# if already applied, so this is safe on every boot and across replicas.
CMD ["sh", "-c", "node adapters/migrate.mjs && node --import tsx server/index.js"]
