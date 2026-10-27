FROM oven/bun:1 AS base
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Jakarta

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json index.ts ./
COPY src ./src

# Sesi WhatsApp disimpan di volume ini (lihat docker-compose.yml).
RUN mkdir -p /app/data/wa-auth && chown -R bun:bun /app/data

USER bun
CMD ["bun", "index.ts"]
