FROM node:22-alpine
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--workspace", "@urbanpulse/web", "--", "--host", "0.0.0.0"]
