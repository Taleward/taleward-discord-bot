# Grundbild mit fester Prüfsumme (node:22.22.0-bookworm-slim, Stand 24.10.2026).
# Neue Fassung: Tag und Prüfsumme gemeinsam ändern, Prüfsumme mit
#   docker buildx imagetools inspect node:<tag> --format '{{.Manifest.Digest}}'
ARG GRUNDBILD=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

# Bauen
FROM ${GRUNDBILD} AS bauen
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Laufen: nur dist und die Laufzeit-Abhängigkeiten, als Nutzer 1000
FROM ${GRUNDBILD}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=bauen /app/package.json ./
COPY --from=bauen /app/node_modules ./node_modules
COPY --from=bauen /app/dist ./dist
# Aufnahmen der Erprobung: eigener Datenträger (docker-compose.yml), nur für Nutzer 1000 lesbar.
RUN mkdir -p /aufnahmen && chown 1000:1000 /aufnahmen && chmod 700 /aufnahmen
USER 1000:1000
CMD ["node", "dist/index.js"]
