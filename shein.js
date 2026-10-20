/**
 * SHEIN Open Platform (Autooperação) — autorização da loja e chamadas assinadas.
 *
 * Railway:  SHEIN_APP_ID, SHEIN_APP_SECRET   (app "Painel Zagodini" na Plataforma Aberta)
 * Autorizar uma loja (admin):  /shein/conectar?loja=zagodini   (ou mae)
 * Retorno:                     /shein/callback  → troca o tempToken por openKeyId + secretKey (guardados no disco)
 *
 * Assinatura (x-lt-signature): random(5) + base64( hex( HMAC-SHA256( key = secretKey + random, value = openKeyId&timestamp&path ) ) )
 * secretKey da loja vem criptografado: AES-128-CBC, chave = 16 primeiros bytes do APP_SECRET, IV = "space-station-de"
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const router = express.Router();
const ARQ = path.join(DATA, 'shein_tokens.json');
const BASE = process.env.SHEIN_BASE || 'https://openapi.sheincorp.com';
const AUTH_URL = process.env.SHEIN_AUTH_URL || 'https://openapi-sem.sheincorp.com/#/empower';
const LOJAS = { zagodini: 'Zagodini', mae: 'Com Amor de Mãe', lufe: 'Lufe' };

const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ)); } catch (e) { return {}; } };
const gravar = t => { try { fs.writeFileSync(ARQ, JSON.stringify(t, null, 1)); } catch (e) { console.warn('[shein] gravar', e.message); } };
const configurado = () => !!(process.env.SHEIN_APP_ID && process.env.SHEIN_APP_SECRET);
const soAdmin = (req, res, next) => (!require('./auth').ativo() || req.usuario?.admin) ? next() : res.status(403).send('Só o administrador.');
const base = req => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`).replace(/\/$/, '');

function assinar(openKeyId, secretKey, apiPath, timestamp) {
  const rnd = crypto.randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(5, 'x').slice(0, 5);
  const hex = crypto.createHmac('sha256', secretKey + rnd).update(`${openKeyId}&${timestamp}&${apiPath}`).digest('hex');
  return rnd + Buffer.from(hex).toString('base64');
}
function decifrar(conteudo, chave) {
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(chave, 'utf8').subarray(0, 16), Buffer.from('space-station-default-iv').subarray(0, 16));
  return Buffer.concat([d.update(Buffer.from(conteudo, 'base64')), d.final()]).toString('utf8');
}
async function chamarAssinado(openKeyId, secretKey, apiPath, body, extraHeaders = {}, metodo = 'POST') {
  const ts = String(Date.now());
  const headers = { 'Content-Type': 'application/json;charset=UTF-8', 'x-lt-openKeyId': openKeyId, 'x-lt-timestamp': ts, 'x-lt-signature': assinar(openKeyId, secretKey, apiPath, ts), ...extraHeaders };
  const r = await axios({ method: metodo, url: BASE + apiPath, data: metodo === 'GET' ? undefined : (body || {}), params: metodo === 'GET' ? body : undefined, headers, validateStatus: () => true, timeout: 30000 });
  if (r.status >= 400) throw Object.assign(new Error('SHEIN HTTP ' + r.status + ': ' + JSON.stringify(r.data).slice(0, 300)), { resposta: r.data });
  return r.data;
}
/** Chamada na loja autorizada (openKeyId/secretKey da loja) */
async function api(loja, apiPath, body, metodo = 'POST') {
  const t = ler()[loja];
  if (!t?.openKeyId) throw new Error('Loja ' + loja + ' não autorizada na SHEIN — abra /shein/conectar?loja=' + loja);
  return chamarAssinado(t.openKeyId, t.secretKey, apiPath, body, {}, metodo);
}

router.get('/conectar', soAdmin, (req, res) => {
  if (!configurado()) return res.status(400).send('Falta configurar SHEIN_APP_ID e SHEIN_APP_SECRET no Railway.');
  const loja = LOJAS[req.query.loja] ? req.query.loja : 'zagodini';
  const redirect = Buffer.from(base(req) + '/shein/callback').toString('base64');
  res.redirect(`${AUTH_URL}?appid=${encodeURIComponent(process.env.SHEIN_APP_ID)}&redirectUrl=${encodeURIComponent(redirect)}&state=${loja}`);
});
router.get('/callback', soAdmin, async (req, res) => {
  const loja = LOJAS[req.query.state] ? req.query.state : 'zagodini';
  const temp = req.query.tempToken || req.query.temp_token;
  if (!temp) return res.status(400).send('<h2>❌ A SHEIN não devolveu o tempToken</h2><pre>' + JSON.stringify(req.query).replace(/</g, '&lt;') + '</pre>');
  try {
    const d = await chamarAssinado(process.env.SHEIN_APP_ID, process.env.SHEIN_APP_SECRET, '/open-api/auth/get-by-token', { tempToken: temp }, { 'x-lt-appid': process.env.SHEIN_APP_ID });
    const info = d.info || d.data || {};
    if (!info.openKeyId || !info.secretKey) throw new Error('resposta sem openKeyId/secretKey: ' + JSON.stringify(d).slice(0, 300));
    const T = ler();
    T[loja] = { openKeyId: info.openKeyId, secretKey: decifrar(info.secretKey, process.env.SHEIN_APP_SECRET), supplierId: info.supplierId || null, em: new Date().toISOString() };
    gravar(T);
    res.send(`<!DOCTYPE html><meta charset="UTF-8"><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2f5"><div style="background:white;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px #0001"><div style="font-size:48px">✅</div><h2 style="color:#1e7e34">SHEIN autorizada!</h2><p>${LOJAS[loja]}</p><a href="/painel.html" style="display:inline-block;padding:12px 28px;background:#0d1b2a;color:white;border-radius:8px;text-decoration:none">← Voltar ao painel</a></div></body>`);
  } catch (e) { res.status(500).send('<h2>❌ Erro ao autorizar a SHEIN</h2><pre>' + String(e.message).replace(/</g, '&lt;') + '</pre><a href="/shein/conectar?loja=' + loja + '">Tentar de novo</a>'); }
});
router.get('/status', soAdmin, (req, res) => {
  const T = ler();
  res.json({ configurado: configurado(), callback: base(req) + '/shein/callback', lojas: Object.fromEntries(Object.keys(LOJAS).map(k => [k, T[k] ? { autorizada: true, em: T[k].em, supplierId: T[k].supplierId } : { autorizada: false }])) });
});
// diagnóstico (admin): POST /shein/raw?loja=zagodini&path=/open-api/order/order-list  com body JSON
router.post('/raw', soAdmin, express.json(), async (req, res) => {
  if (!/^\/open-api\//.test(String(req.query.path || ''))) return res.status(400).json({ erro: 'path inválido' });
  try { res.json(await api(String(req.query.loja || 'zagodini'), String(req.query.path), req.body || {}, req.query.metodo === 'GET' ? 'GET' : 'POST')); }
  catch (e) { res.status(500).json({ erro: e.message, resposta: e.resposta }); }
});

module.exports = { router, api, LOJAS };
