# Painel Marketplaces na nuvem (Railway)

## Variáveis de ambiente (Railway → serviço → Variables)
Copie do seu `.env` do Mac e acrescente as de login:

| Variável | Valor |
|---|---|
| `ADMIN_EMAIL` | e-mail do administrador (primeiro login) |
| `ADMIN_SENHA` | senha inicial do administrador (troque depois em ⚙️ Conta) |
| `SESSION_SECRET` | texto aleatório longo (assina os cookies de login) |
| `DATA_DIR` | `/data` (já vem no Dockerfile) |
| `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_IDS` | do .env |
| `ML_ZAGODINI_CID`, `ML_ZAGODINI_SECRET`, `ML_MAE_CID`, `ML_MAE_SECRET`, `ML_LUFE_CID`, `ML_LUFE_SECRET` | do .env |
| `BLING_ZAGODINI_ID`, `BLING_ZAGODINI_SECRET`, `BLING_MAE_ID`, `BLING_MAE_SECRET` | do .env |
| `BLING_REDIRECT_URI` | `https://SEU-DOMINIO.up.railway.app/bling/callback` |
| `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY` | do .env |
| `SHOPEE_REDIRECT_URL` | `https://SEU-DOMINIO.up.railway.app/shopee/callback` |
| `TINY_LUFE_TOKEN` | do .env |

## Volume (disco persistente)
Railway → serviço → **Volumes → New Volume**, montado em **`/data`**.
Tudo o que muda (tokens, usuários, planilhas, cache das apurações) fica ali.

## Migração (uma vez)
1. Entre no painel com ADMIN_EMAIL/ADMIN_SENHA → **⚙️ Conta**.
2. Em **Enviar planilha ou arquivo de dados**, envie do Mac (pasta ml-painel):
   `tokens.json`, `bling_tokens.json`, `shopee_tokens.json`, `notificadas.json`, `impostos.json`,
   `custo_por_sku.json`, `fixo_por_sku.json`, `apuracao_cache/tiny_lufe_pedidos.json`
   e as planilhas `Precificacao Nova.xlsx`, `Precificacao Comercial Zagodini.xlsx`, `Precificacao Atelie Com S2 de Mãe.xlsx`.
3. **Desligue o painel do Mac** depois disso. Os dois juntos disputam os mesmos tokens
   (o ML/Bling invalidam o refresh token antigo) e o bot do Telegram.
4. No Bling (developer.bling.com.br) troque a URL de redirecionamento dos apps para a do Railway.

## O que não roda na nuvem
- Boost da Shopee (usa o Chrome do Mac) — desligado automaticamente.
- Apuração Amazon por upload de arquivo **.xls** antigo (precisa LibreOffice); **.xlsx** funciona.
