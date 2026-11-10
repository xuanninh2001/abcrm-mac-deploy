FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@10.28.0
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
USER node
CMD ["pnpm", "--filter", "@abcrm/app", "start"]

FROM base AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @abcrm/web build

FROM web-build AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN chown -R node:node /app/apps/web/.next
USER node
EXPOSE 3001
CMD ["pnpm", "--filter", "@abcrm/web", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3001"]
