FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate
RUN npm run build
EXPOSE 4000
CMD ["node", "dist/server.js"]
