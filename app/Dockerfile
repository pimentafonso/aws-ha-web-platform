# syntax=docker/dockerfile:1.7

FROM node:22.23.5-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.23.5-alpine
ENV NODE_ENV=production
WORKDIR /app

# CA bundle used to verify the RDS server certificate (DB_SSL_CA_PATH).
# The directory is created first: ADD --chmod would otherwise also give the
# directory it creates mode 444, and without the execute bit the file inside
# cannot be opened.
RUN mkdir -m 755 /etc/ssl/rds
ADD --chmod=444 https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem /etc/ssl/rds/eu-west-1-bundle.pem

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations

USER node
EXPOSE 3000
# Run node directly (not npm) so SIGTERM from ECS reaches the process.
CMD ["node", "src/server.js"]
