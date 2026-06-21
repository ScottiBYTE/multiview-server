FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY src/package*.json ./
RUN npm ci --omit=dev

COPY src/ ./
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=8080
ENV MULTIVIEW_DATA_DIR=/app/data

EXPOSE 8080

CMD ["npm", "start"]
