FROM oven/bun:1 AS base
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Jakarta

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json index.ts ./
COPY src ./src

USER bun
CMD ["bun", "index.ts"]
