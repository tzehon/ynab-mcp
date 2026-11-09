FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ARG SOURCE_REVISION=unrecorded
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY deploy/entrypoint.sh /usr/local/bin/ynab-entrypoint
COPY scripts/authorization-admin.mjs ./scripts/authorization-admin.mjs
COPY scripts/recover-ownership.mjs ./scripts/recover-ownership.mjs
RUN chmod 0555 /usr/local/bin/ynab-entrypoint
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/ynab-entrypoint"]
CMD ["node", "dist/main.js"]
