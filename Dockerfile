FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN mkdir -p src/content/blog
RUN npm run build

EXPOSE 4321

ENV HOST=0.0.0.0
ENV PORT=4321

# Every node process in this image runs the secret guard first, so a
# configured-but-unusable secret stops the container instead of surfacing as a
# 500 from one route. Set after the build so it does not apply during `npm ci`.
ENV NODE_OPTIONS=--import=/app/scripts/assert-secrets.mjs

# Mode is chosen by BLOG_MODE, never by a template Command/Post Arguments field:
# the Unraid Tailscale hook ignores the former and appends the latter as argv.
CMD ["sh", "scripts/start.sh"]
