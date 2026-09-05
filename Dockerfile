FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 7100
CMD ["node", "--import", "tsx", "server/index.js"]
