# Runtime-only image. server.js is zero-dependency and static/catalog.json is
# prebuilt and committed, so there is NO npm install step — the image is just
# Node + your files. Rebuild the catalog with `npm run build:catalog` BEFORE
# `docker build`, or wire it into CI.
FROM node:20-alpine

# Run as an unprivileged user; the server only reads static/ and binds a port.
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Copy only what the runtime needs. Nothing else.
COPY --chown=app:app server.js ./
COPY --chown=app:app static ./static
COPY --chown=app:app package.json ./

USER app
ENV NODE_ENV=production \
    MODE=mirror \
    PORT=3000
EXPOSE 3000

# Liveness probe hits the same /healthz the portal's fallback-domain checker uses.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
