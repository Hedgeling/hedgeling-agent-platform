FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api-contract/package.json packages/api-contract/package.json
COPY packages/platform-client/package.json packages/platform-client/package.json
COPY packages/platform-mcp/package.json packages/platform-mcp/package.json
COPY packages/design-system/package.json packages/design-system/package.json
COPY packages/web-console/package.json packages/web-console/package.json
RUN npm ci --omit=dev --workspace @hedgeling/web-console --workspace @hedgeling/api-contract

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/api-contract ./packages/api-contract
COPY packages/web-console ./packages/web-console
COPY packages/design-system ./packages/design-system
EXPOSE 8080
CMD ["node", "packages/web-console/src/server.js"]
