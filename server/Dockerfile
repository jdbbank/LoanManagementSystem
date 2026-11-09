FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
COPY mailer/package.json ./mailer/package.json
RUN npm ci
COPY server ./server
RUN npm run build --workspace server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
COPY mailer/package.json ./mailer/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
# utils/logger.ts writes hourly files next to the compiled logger, so that one directory has to be
# writable by the unprivileged user. A named volume mounted here inherits this ownership.
RUN mkdir -p server/dist/logs && chown -R node:node server/dist/logs
USER node
EXPOSE 4000
CMD ["node", "server/dist/index.js"]
