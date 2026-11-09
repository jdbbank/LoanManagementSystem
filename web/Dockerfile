FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
COPY mailer/package.json ./mailer/package.json
RUN npm ci
# ManualPage.tsx imports '../../../USER-MANUAL-EN.md?raw', which from /app/web/src/pages resolves
# to /app/USER-MANUAL-EN.md — the repo root, not inside web/. Without this COPY the build fails
# with UNRESOLVED_IMPORT, and the two files must stay in sync with the version in the repo root.
COPY USER-MANUAL-EN.md USER-MANUAL-TH.md ./
COPY web ./web
RUN npm run build --workspace web

FROM nginx:1.29-alpine
# Dev keeps the /api proxy; docker-compose.prod.yml builds with web/nginx.prod.conf and lets Kong route.
ARG WEB_NGINX_CONF=web/nginx.conf
COPY ${WEB_NGINX_CONF} /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
