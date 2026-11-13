FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# Next.js serializes rewrites at build time, so the backend proxy target is baked in here.
ARG BACKEND_URL=http://backend:8000
ENV BACKEND_URL=$BACKEND_URL

RUN mkdir -p public
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# HOSTNAME=0.0.0.0: Docker sets HOSTNAME to the container ID, which would make the
# standalone server bind only to the container IP and break the loopback healthcheck.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD wget -q --spider http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.js"]
