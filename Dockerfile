FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.html styles.css app.js server.js boss-clear.png focus-snake.gif pause-snake.gif extract-snake.gif ./

ENV PORT=8757
EXPOSE 8757

USER node

CMD ["node", "server.js"]
