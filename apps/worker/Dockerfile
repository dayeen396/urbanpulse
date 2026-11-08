FROM node:22-alpine
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci
COPY . .
RUN npm run build --workspace @urbanpulse/worker
CMD ["npm", "run", "start", "--workspace", "@urbanpulse/worker"]
