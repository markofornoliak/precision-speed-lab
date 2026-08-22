FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
