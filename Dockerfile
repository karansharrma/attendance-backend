# syntax=docker/dockerfile:1

# ---- deps ------------------------------------------------------------------
# bcrypt is a native module, so the build stage needs a toolchain. Keeping it in a
# throwaway stage is what stops python3/make/g++ from shipping in the runtime image.
FROM node:22-alpine AS deps
WORKDIR /app

RUN apk add --no-cache python3 make g++ libc6-compat openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate
RUN npm run build
# Drop dev dependencies now that dist/ exists.
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Prisma's query engine links against OpenSSL.
RUN apk add --no-cache openssl dumb-init

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

# Never run as root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init gives PID 1 proper signal handling so SIGTERM reaches Node and Prisma
# disconnects cleanly instead of the container being killed after the grace period.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
