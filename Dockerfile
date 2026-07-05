# WebClaudeCode relay — the untrusted WebSocket pipe (the ONLY component you host publicly).
# The daemon runs on your own machine and dials out to this relay; browsers connect to it too.
# It holds no secrets beyond an auth token and never sees plaintext once payload encryption (#15) lands.
FROM node:22-slim

WORKDIR /app

# Install deps first for better layer caching. tsx (a devDependency) runs the TS entrypoint directly,
# so we do a full install rather than --omit=dev.
COPY package.json package-lock.json ./
RUN npm ci

# Source needed at runtime: the relay + shared packages, plus tsconfig for the @wcc/shared path alias.
# tsconfig.json `extends` tsconfig.base.json, and the @wcc/shared `paths` mapping lives in the base —
# both must be present or tsx cannot resolve the alias at runtime (ERR_MODULE_NOT_FOUND).
COPY tsconfig.json tsconfig.base.json ./
COPY packages/relay ./packages/relay
COPY packages/shared ./packages/shared

ENV NODE_ENV=production
# Cloud platforms inject PORT; this default only applies to a bare `docker run`.
ENV PORT=8787
EXPOSE 8787

# RELAY_TOKEN (or RELAY_JWT_SECRET) MUST be provided at runtime — the relay hard-fails in production
# without credentials rather than fall back to the insecure dev token.
CMD ["npx", "tsx", "packages/relay/src/index.ts"]
