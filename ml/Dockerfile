FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Pre-bake the ONNX embedding model so container cold-starts don't fetch from HuggingFace
RUN node -e "(async () => { const t = await import('@xenova/transformers'); await t.pipeline('feature-extraction', process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2'); })()"

COPY --from=build /app/dist ./dist
EXPOSE 5000
CMD ["node", "dist/index.js"]
