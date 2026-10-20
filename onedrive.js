/**
 * OneDrive (conta Microsoft pessoal) — lê planilhas do OneDrive do Diego via Microsoft Graph.
 *
 * Variáveis no Railway:  MS_CLIENT_ID, MS_CLIENT_SECRET  (app criado em entra.microsoft.com → Registros de aplicativo)
 * URI de redirecionamento do app:  https://<painel>/onedrive/callback
 *
 * Rotas (só administrador):
 *   GET /onedrive/conectar          → login na Microsoft (uma vez)
 *   GET /onedrive/callback          → recebe o código e guarda os tokens
 *   GET /onedrive/status            → conectado? conta?
 *   GET /onedrive/planilha?link=... → baixa a planilha pelo link de compartilhamento e mostra as abas e as primeiras linhas
 */
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const DATA = require('./dados');

const router = express.Router();
const ARQ = path.join(DATA, 'onedrive_tokens.json');
const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const ESCOPO = 'offline_access Files.Read.All User.Read';

const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ)); } catch (e) { return {}; } };
const gravar = t => { try { fs.writeFileSync(ARQ, JSON.stringify(t)); } catch (e) { console.warn('[onedrive] gravar', e.message); } };
const base = req => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const redirectUri = req => base(req) + '/onedrive/callback';
const configurado = () => !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
const soAdmin = (req, res, next) => (!require('./auth').ativo() || req.usuario?.admin) ? next() : res.status(403).send('Só o administrador.');

async function trocar(params) {
  const body = new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: ESCOPO, ...params });
  const { data } = await axios.post(AUTH + '/token', body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const t = { ...ler(), access_token: data.access_token, refresh_token: data.refresh_token || ler().refresh_token, expira: Date.now() + (data.expires_in - 120) * 1000, redirect: params.redirect_uri || ler().redirect };
  gravar(t);
  return t;
}
async function token() {
  let t = ler();
  if (!t.refresh_token) throw new Error('OneDrive não conectado — abra /onedrive/conectar');
  if (!t.access_token || Date.now() > (t.expira || 0)) t = await trocar({ grant_type: 'refresh_token', refresh_token: t.refresh_token, redirect_uri: t.redirect });
  return t.access_token;
}
const graph = async (url, opts = {}) => (await axios.get('https://graph.microsoft.com/v1.0' + url, { ...opts, headers: { Authorization: 'Bearer ' + await token() } })).data;

/** link de compartilhamento (1drv.ms ou onedrive.live.com com redeem=) → id para a API /shares */
function idCompartilhamento(link) {
  let u = String(link || '').trim();
  try { const r = new URL(u).searchParams.get('redeem'); if (r) u = Buffer.from(r, 'base64').toString('utf8'); } catch (e) {}
  return 'u!' + Buffer.from(u).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}
/** Baixa a planilha (Buffer) e devolve o workbook do xlsx */
async function lerPlanilha(link) {
  const id = idCompartilhamento(link);
  const info = await graph(`/shares/${id}/driveItem?select=name,size,lastModifiedDateTime`);
  const bin = await graph(`/shares/${id}/driveItem/content`, { responseType: 'arraybuffer' });
  return { info, wb: XLSX.read(Buffer.from(bin), { type: 'buffer', cellDates: true }) };
}

router.get('/conectar', soAdmin, (req, res) => {
  if (!configurado()) return res.status(400).send('Falta configurar MS_CLIENT_ID e MS_CLIENT_SECRET no Railway.');
  const q = new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(req), response_mode: 'query', scope: ESCOPO, prompt: 'select_account' });
  res.redirect(AUTH + '/authorize?' + q);
});
router.get('/callback', soAdmin, async (req, res) => {
  if (req.query.error) return res.status(400).send('<h2>❌ Microsoft recusou</h2><p>' + String(req.query.error_description || req.query.error).replace(/</g, '&lt;') + '</p>');
  try {
    await trocar({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri(req) });
    const eu = await graph('/me?select=displayName,userPrincipalName').catch(() => ({}));
    const t = ler(); t.conta = eu.userPrincipalName || eu.displayName || ''; gravar(t);
    res.send(`<!DOCTYPE html><meta charset="UTF-8"><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2f5"><div style="background:white;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px #0001"><div style="font-size:48px">✅</div><h2 style="color:#1e7e34">OneDrive conectado!</h2><p>${t.conta}</p><a href="/painel.html" style="display:inline-block;padding:12px 28px;background:#0d1b2a;color:white;border-radius:8px;text-decoration:none">← Voltar ao painel</a></div></body>`);
  } catch (e) { res.status(500).send('<h2>❌ Erro ao conectar</h2><pre>' + JSON.stringify(e.response?.data || e.message).replace(/</g, '&lt;') + '</pre><a href="/onedrive/conectar">Tentar de novo</a>'); }
});
router.get('/status', soAdmin, (req, res) => { const t = ler(); res.json({ configurado: configurado(), conectado: !!t.refresh_token, conta: t.conta || null, redirect: redirectUri(req) }); });
router.get('/planilha', soAdmin, async (req, res) => {
  try {
    const { info, wb } = await lerPlanilha(req.query.link);
    const abas = wb.SheetNames.map(n => { const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null }); return { aba: n, linhas: rows.length, inicio: rows.slice(0, 8) }; });
    res.json({ arquivo: info.name, modificado: info.lastModifiedDateTime, tamanho: info.size, abas });
  } catch (e) { res.status(e.response?.status || 500).json({ erro: e.response?.data?.error?.message || e.message }); }
});

module.exports = { router, lerPlanilha, idCompartilhamento };
