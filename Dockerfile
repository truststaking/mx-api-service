FROM node:alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --force
COPY . .
RUN npm run init
RUN npm run prebuild
RUN npm run build --if-present
RUN npm run copy-mainnet-config:nix

FROM node:alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/tsconfig.build.json ./tsconfig.build.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

CMD ["node", "/app/dist/src/main.js"]
