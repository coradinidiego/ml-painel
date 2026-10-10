# Painel Marketplaces — imagem para o Railway (Node + Python p/ scripts de planilha)
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-openpyxl tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production \
    DATA_DIR=/data \
    TZ=America/Sao_Paulo
EXPOSE 3000
CMD ["node", "server.js"]
