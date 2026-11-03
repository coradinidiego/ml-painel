/**
 * Reserva da Coleta do Full pelo Telegram (com a extensão "Monitor Full ML").
 *
 * 1) A extensão escolhe o dia da Coleta e chama POST /full/agenda/pedir → o bot pergunta no Telegram
 *    "Reservar Coleta para <dia>?" com os botões ✅ Reservar / ❌ Não.
 * 2) A extensão pergunta a cada ~10 s GET /full/agenda/:id → quando Diego toca em Reservar, vira "sim".
 * 3) A extensão clica no botão final do agendamento e manda POST /full/agenda/:id/resultado → aviso no Telegram.
 * O pedido vale 30 minutos; depois disso expira (a tela pode ter perdido a vaga).
 */
const fs = require('fs');
const path = require('path');
const DATA = require('./dados');

const ARQ = path.join(DATA, 'full_agenda.json');
const VALIDADE = 30 * 60e3;
let R = (() => { try { return JSON.parse(fs.readFileSync(ARQ)); } catch (e) { return {}; } })();
const salvar = () => { try { fs.writeFileSync(ARQ, JSON.stringify(R)); } catch (e) {} };
const esc = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tg = () => require('./telegram');

function situacao(id) {
  const r = R[id]; if (!r) return { status: 'nenhum' };
  if (r.status === 'aguardando' && Date.now() - r.em > VALIDADE) { r.status = 'expirado'; salvar(); }
  return r;
}

/** Resposta vinda do Telegram (botão ou texto "sim"/"não" respondendo a pergunta). */
async function responder(id, resp) {
  const r = situacao(id);
  if (r.status !== 'aguardando') return r.status === 'expirado' ? '⌛ Esse pedido expirou (mais de 30 min). Confira a tela do ML.' : 'Esse pedido já foi respondido.';
  r.status = resp === 'sim' ? 'sim' : 'nao'; r.respondidoEm = Date.now(); salvar();
  return resp === 'sim' ? '👍 Ok! Reservando a Coleta de ' + r.data + ' no Mercado Livre…' : '👌 Ok, não vou reservar. A tela continua aberta com o dia escolhido.';
}

module.exports = function (app) {
  app.post('/full/agenda/pedir', require('express').json(), async (req, res) => {
    if (require('./auth').ativo() && !req.usuario) return res.status(401).json({ erro: 'login' });
    const id = String(req.body?.id || '').replace(/\D/g, ''); if (!id) return res.status(400).json({ erro: 'id' });
    const ja = situacao(id);
    if (['aguardando', 'sim'].includes(ja.status)) return res.json({ ok: true, ja: true, status: ja.status });
    R[id] = { status: 'aguardando', em: Date.now(), data: String(req.body.data || '').slice(0, 60), hora: req.body.hora ? String(req.body.hora).slice(0, 60) : null, url: String(req.body.url || '').slice(0, 300) };
    salvar();
    await tg().sendTelegram('📦 <b>Full ML: a Coleta liberou!</b>\nEnvio ' + id + '\nEscolhi o dia <b>' + esc(R[id].data) + '</b>' + (R[id].hora ? ' · ' + esc(R[id].hora) : '') +
      '\n\nQuer que eu reserve? (vale por 30 min)\nFULLRES:' + id,
      { inline_keyboard: [[{ text: '✅ Reservar', callback_data: 'FULLRES:' + id + ':sim' }, { text: '❌ Não', callback_data: 'FULLRES:' + id + ':nao' }]] });
    res.json({ ok: true, status: 'aguardando' });
  });
  app.get('/full/agenda/:id', (req, res) => {
    if (require('./auth').ativo() && !req.usuario) return res.status(401).json({ erro: 'login' });
    res.json(situacao(String(req.params.id)));
  });
  app.post('/full/agenda/:id/resultado', require('express').json(), async (req, res) => {
    if (require('./auth').ativo() && !req.usuario) return res.status(401).json({ erro: 'login' });
    const id = String(req.params.id), r = R[id]; if (!r) return res.status(404).json({ erro: 'sem pedido' });
    r.status = req.body?.ok ? 'reservado' : 'erro'; r.resultado = String(req.body?.texto || '').slice(0, 500); r.fimEm = Date.now(); salvar();
    await tg().sendTelegram(req.body?.ok
      ? '✅ <b>Coleta reservada!</b>\nEnvio ' + id + ' · ' + esc(r.data) + (r.resultado ? '\n<i>' + esc(r.resultado.slice(0, 200)) + '</i>' : '')
      : '⚠️ <b>Não consegui reservar a Coleta</b>\nEnvio ' + id + ' · ' + esc(r.data) + '\n' + esc(r.resultado || '') + '\nAbra a tela e confirme na mão: ' + esc(r.url));
    res.json({ ok: true });
  });
};
module.exports.responder = responder;
