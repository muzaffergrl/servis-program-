FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# Veritabanı kalıcı diskte durmalı (sunucuda /data diski bağlanır)
ENV DB_FILE=/data/servis.db
EXPOSE 3000
CMD ["node", "src/server.js"]
