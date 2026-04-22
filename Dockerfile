FROM node:22-alpine

WORKDIR /app

# Install deps first for layer caching
COPY package*.json ./
RUN npm ci

# Copy app source (content dir is mounted at runtime)
COPY . .

# Ensure content dir exists for build — will be overlaid by volume mount
RUN mkdir -p src/content/blog

RUN npm run build

EXPOSE 4321

ENV HOST=0.0.0.0
ENV PORT=4321

CMD ["node", "./dist/server/entry.mjs"]
