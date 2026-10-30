# ml-painel — instruções para o Claude

Painel de marketplaces do Diego (Mercado Livre, Amazon, Shein, Shopee, Bling).

## Onde está o código e como publicar
- Este repositório (`coradinidiego/ml-painel`, branch `main`) é a **fonte da verdade**.
- Deploy: **push na `main` = deploy automático no Railway** (serviço `intelligent-truth`).
  Confira em `gh api repos/coradinidiego/ml-painel/commits/<sha>/status` (vira `success`).
- A pasta `~/ml-painel` no Mac do Diego é uma cópia antiga, sem git. **Não edite lá.**

## Como o Diego quer trabalhar
- Ele pede a mudança; o Claude altera, faz commit, push na `main` e acompanha o deploy.
  Não devolver código para ele colar.
- Responder em português.

## Estrutura
- `server.js` — Express (rotas e APIs). `painel.html` — front-end inteiro (CSS + JS inline).
- Integrações: `promos_ml.js`, `bling.js`, `shopee.js`, `shein.js`, `amazon.js`, `telegram.js`, etc.
- Dados persistentes no volume `/data` do Railway (`DATA_DIR`), não no repositório.
