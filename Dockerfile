# Wyre production Dockerfile
FROM node:20-bookworm-slim

# mongodb-memory-server (embedded MongoDB) needs libcurl at runtime to
# download and run the real mongod binary.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libcurl4 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source and build
COPY . .
RUN npm run build

ENV NODE_ENV=development
EXPOSE 3000

CMD ["npm", "start"]
