FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
COPY mailer/package.json ./mailer/package.json
RUN npm ci
COPY mailer ./mailer
RUN npm run build --workspace mailer

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
COPY mailer/package.json ./mailer/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/mailer/dist ./mailer/dist
EXPOSE 4100
CMD ["node", "mailer/dist/index.js"]
