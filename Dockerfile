# Base on Debian (not alpine) - Chromium's stealth build here (via
# puppeteer-real-browser) needs glibc, not musl, and the standard Debian
# Chrome dependency list is well documented; alpine's isn't worth the fight.
FROM node:22-bookworm-slim

# - chromium/xvfb: puppeteer-real-browser drives a real (non-headless) Chrome
#   (see getBrowser() in server/bot.js, headless:false) - xvfb gives it a
#   virtual display since the container has no real one.
# - build-essential/python3: better-sqlite3 compiles a native addon on
#   `npm install`; without these the install fails outright.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    xauth \
    build-essential \
    python3 \
    ca-certificates \
    fonts-liberation \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium

WORKDIR /app

# Install deps first (separate layer) so code-only changes don't bust the
# native-module build cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./server/

# server/data (SQLite DB, chrome-profile, lock file) is meant to be a
# volume mount, not baked into the image - see docker-compose.yml.
RUN mkdir -p server/data

# R2 credentials come in as real environment variables via docker-compose's
# env_file, not a .env file inside the image - no --env-file flag needed here.
ENTRYPOINT ["xvfb-run", "-a", "node", "server/bot.js"]
