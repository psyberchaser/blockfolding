FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json tsconfig.json ./
RUN npm ci

FROM deps AS build-api
COPY . .
RUN npx tsc -p tsconfig.json --noEmitOnError false || true

FROM node:22-alpine AS build-ui
WORKDIR /app/validator-ui
RUN apk add --no-cache python3 make g++
COPY validator-ui/package.json ./
RUN rm -f package-lock.json && npm install
COPY validator-ui/ ./
RUN npx vite build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libstdc++
COPY --from=build-api /app/dist /app/dist
COPY --from=build-api /app/node_modules /app/node_modules
COPY --from=build-api /app/package.json /app/
COPY --from=build-api /app/artifacts/codebooks /app/default-codebooks
COPY --from=build-ui /app/validator-ui/dist /app/validator-ui/dist

EXPOSE 8080
CMD sh -c 'DATA="${DATA_DIR:-/app/artifacts}"; mkdir -p "$DATA/codebooks"; \
  if [ ! -f "$DATA/codebooks/latest.json" ] && [ -d /app/default-codebooks ]; then \
    cp -n /app/default-codebooks/* "$DATA/codebooks/"; \
  fi; \
  exec node dist/api/server.js'
