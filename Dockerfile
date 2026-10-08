# Railway build. No compiler toolchain needed: SQLite is the built-in
# node:sqlite module, and sharp ships prebuilt libvips for linux x64/arm64
# (glibc — hence Debian bookworm, not Alpine).
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY shared ./shared
COPY public ./public
COPY pages ./pages

# Runs as root on purpose: Railway mounts Volumes owned by root, and DB_PATH /
# LOCAL_UPLOAD_DIR must be writable inside that mount.
EXPOSE 8811
CMD ["node", "src/server.js"]
