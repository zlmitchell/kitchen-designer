# syntax=docker/dockerfile:1
#
# Kitchen designer. The 3D rendering happens in the browser, not in here --
# this image only builds and serves static files, so it needs no GPU and no
# headless GL. Build context is the repo root; `app/` is the forked architect3d.

FROM node:22-alpine AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
# --ignore-scripts skips two postinstalls we have no use for in an image:
# playwright's browser download (~400MB, only needed by `npm run test:browser`)
# and simple-git-hooks, which needs a .git dir that is not copied in.
RUN npm ci --ignore-scripts

# ---- dev: vite + HMR, source bind-mounted by compose ----
FROM deps AS dev
ENV NODE_ENV=development
COPY app/ .
EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173"]

# ---- build: the Vue application -> dist-demo/ ----
FROM deps AS build
COPY app/ .
RUN npm run build:demo

# ---- prod: nginx serving the built app ----
FROM nginx:alpine AS prod
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist-demo /usr/share/nginx/html
EXPOSE 80
