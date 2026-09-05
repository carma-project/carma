FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 7100
# Run migrations (idempotent, advisory-locked) then start. Migrations are skipped
# if already applied, so this is safe on every boot and across replicas.
CMD ["sh", "-c", "node adapters/migrate.mjs && node --import tsx server/index.js"]
