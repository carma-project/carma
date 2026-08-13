# Setup Guide

## Prerequisites
Node 20+, Docker, Postgres 15+

## Local
1. git clone
2. cp .env.example .env
3. docker compose up --build
4. curl http://localhost:7100/resolve?uri=memory://acme/sem/example

## Railway
1. Connect repo
2. Add Postgres service
3. Set env vars: DATABASE_URL, PRIVATE_KEY, PUBLIC_KEY
4. Deploy

## Testing
node test/hermes_client.mjs memory://acme/sem/example
