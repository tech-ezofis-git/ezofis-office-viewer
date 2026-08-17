FROM node:20-bookworm-slim

# --no-install-recommends is deliberate: it keeps the JRE out of the image.
# Draw's PDF import and ODG export are native and do not need Java.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-draw \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# LibreOffice writes profile data to $HOME; parts of the container FS are read-only.
ENV HOME=/tmp

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "server.js"]