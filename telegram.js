const https = require('https');
const axios = require('axios');
const fs = require('fs');

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').filter(Boolean);
const BASE_ML = 'https://api.mercadolibre.com';

const CONTAS = [
  { nome: 'Zagodini', idx: 0 },
  { nome: 'Com Amor de Mae', idx: 1 },
  { nome: 'Magazine Lufe', idx: 2 }
];

// Avisos já enviados: { ml: { perguntaId: {em, lembretes} }, shp: { conversaId: {msg, em, lembretes} } }
// em = último envio (ms). Lembrete a cada 30 min enquanto não for respondida, até LEMBRETES_MAX vezes.
const LEMBRETE_MIN = 30, LEMBRETES_MAX = 3;
let avisos = { ml: {}, shp: {} };
try {
  const v = JSON.parse(fs.readFileSync('notificadas.json'));
  if (Array.isArray(v)) v.forEach(id => avisos.ml[id] = { em: Date.now(), lembretes: 0 });   // formato antigo
  else avisos = { ml: v.ml || {}, shp: v.shp || {} };
} catch (e) {}
function salvarNotificadas() {
  try { fs.writeFileSync('notificadas.json', JSON.stringify(avisos)); } catch (e) {}
}
const esc = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const minutos = ms => Math.round((Date.now() - ms) / 60000);
function precisaLembrete(a) { return a && a.lembretes < LEMBRETES_MAX && Date.now() - a.em >= LEMBRETE_MIN * 60000; }

function sendTelegramTo(chatId, msg, replyMarkup) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: msg,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot'+TOKEN+'/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let b = ''; res.on('data', d => b+=d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, raw: b }); } });
    });
    req.on('error', e => resolve({ ok: false, erro: e.message })); // falha de rede não derruba o servidor
    req.write(body); req.end();
  });
}

function sendTelegram(msg, replyMarkup) {
  return Promise.all(CHAT_IDS.map(id => sendTelegramTo(id, msg, replyMarkup)));
}

function getToken(idx) {
  const tokens = JSON.parse(fs.readFileSync('tokens.json'));
  return tokens[CONTAS[idx].nome === 'Zagodini' ? 'Zagodini' : CONTAS[idx].nome === 'Com Amor de Mae' ? 'Mae' : 'Lufe'].token;
}

async function verificarPerguntas() {
  for (const conta of CONTAS) {
    try {
      const token = getToken(conta.idx);
      const r = await axios.get(BASE_ML+'/users/me', { headers: { Authorization: 'Bearer '+token } });
      const uid = r.data.id;
      const perg = await axios.get(BASE_ML+'/questions/search?seller_id='+uid+'&status=UNANSWERED&limit=50', { headers: { Authorization: 'Bearer '+token } });
      const qs = perg.data.questions || [];
      const abertas = new Set(qs.map(q => String(q.id)));
      // perguntas desta conta que já foram respondidas (no ML ou pelo Telegram) saem da lista de avisos
      for (const [id, a] of Object.entries(avisos.ml)) if (a.idx === conta.idx && !abertas.has(id)) delete avisos.ml[id];

      for (const q of qs) {
        const id = String(q.id);
        const a = avisos.ml[id];
        if (a && !precisaLembrete(a)) continue;

        let titulo = q.item_id;
        try {
          const item = await axios.get(BASE_ML+'/items/'+q.item_id+'?attributes=title', { headers: { Authorization: 'Bearer '+token } });
          titulo = item.data.title;
        } catch(e) {}

        const lembrete = !!a;
        const desde = new Date(q.date_created).getTime();
        const msg = (lembrete ? '⏰ <b>Lembrete: pergunta sem resposta há '+minutos(desde)+' min - '+conta.nome+'</b>' : '❓ <b>Nova pergunta - '+conta.nome+'</b>')+'\n\n'+
          '📦 <b>Produto:</b> '+esc(titulo)+'\n'+
          '🆔 <b>ID:</b> '+q.item_id+'\n'+
          '❓ <b>Pergunta:</b> '+esc(q.text)+'\n\n'+
          '💬 <i>Responda esta mensagem com sua resposta para postar no ML automaticamente!</i>\n'+
          '🔑 <code>QID:'+q.id+'|IDX:'+conta.idx+'</code>';

        await sendTelegram(msg);
        avisos.ml[id] = { idx: conta.idx, em: Date.now(), lembretes: lembrete ? a.lembretes + 1 : 0 };
        salvarNotificadas();
        console.log((lembrete ? 'Lembrete' : 'Pergunta notificada')+': '+q.id);
      }
    } catch(e) {
      console.log('Erro verificar perguntas '+conta.nome+': '+e.message);
    }
  }
}

// Chat da Shopee (Zagodini): avisa conversas em que o cliente escreveu e ainda não respondemos
async function verificarChatShopee() {
  let shopee;
  try { shopee = require('./shopee'); if (!shopee.getTokens().access_token) return; } catch (e) { return; }
  try {
    const conv = await shopee.listarConversas(2, 100);
    const pend = conv.filter(c => c.pendente);
    const abertas = new Set(pend.map(c => c.id));
    for (const id of Object.keys(avisos.shp)) if (!abertas.has(id)) delete avisos.shp[id];
    for (const c of pend) {
      const a = avisos.shp[c.id];
      const novaMsg = !a || a.msg !== c.ultimaMsgId;          // cliente mandou outra mensagem → avisa de novo
      if (!novaMsg && !precisaLembrete(a)) continue;
      const lembrete = !novaMsg;
      const msg = (lembrete ? '⏰ <b>Lembrete: chat Shopee sem resposta há '+minutos(c.quando)+' min - Zagodini</b>' : '🛍️ <b>Nova mensagem no chat Shopee - Zagodini</b>')+'\n\n'+
        '👤 <b>Cliente:</b> '+esc(c.cliente)+'\n'+
        '💬 <b>Mensagem:</b> '+esc(c.texto || '['+c.tipo+']')+'\n\n'+
        '<i>Responda esta mensagem para enviar a resposta ao cliente na Shopee.</i>\n'+
        '🔑 <code>SCHAT:'+c.id+'|TO:'+c.cliente_id+'</code>';
      await sendTelegram(msg);
      avisos.shp[c.id] = { msg: c.ultimaMsgId, em: Date.now(), lembretes: lembrete ? a.lembretes + 1 : 0 };
      salvarNotificadas();
    }
  } catch (e) { console.log('Erro chat Shopee (Telegram): ' + e.message); }
}

let offset = 0;
async function processarRespostas() {
  try {
    const r = await axios.get('https://api.telegram.org/bot'+TOKEN+'/getUpdates?offset='+offset+'&timeout=30');
    const updates = r.data.result || [];
    
    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.reply_to_message) continue;
      
      const texto = msg.reply_to_message.text || '';
      // Resposta a um chat da Shopee
      const sm = texto.match(/SCHAT:(\d+)\|TO:(\d+)/);
      if (sm && msg.text) {
        try {
          await require('./shopee').enviarMensagem(sm[2], msg.text);
          delete avisos.shp[sm[1]]; salvarNotificadas();
          await sendTelegram('✅ <b>Mensagem enviada ao cliente na Shopee!</b>\n\n<i>'+esc(msg.text)+'</i>');
        } catch (e) { await sendTelegram('❌ Erro ao enviar na Shopee: '+esc(e.message)); }
        continue;
      }
      // Verificar se é resposta a uma pergunta do ML
      const match = texto.match(/QID:(\d+)\|IDX:(\d+)/);
      if (!match) continue;
      
      const qid = match[1];
      const idx = parseInt(match[2]);
      const resposta = msg.text;
      
      if (!resposta) continue;
      
      try {
        const token = getToken(idx);
        await axios.post(BASE_ML+'/answers', {
          question_id: parseInt(qid),
          text: resposta
        }, { headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json' } });
        
        await sendTelegram('✅ <b>Resposta enviada com sucesso!</b>\n\n<i>'+esc(resposta)+'</i>');
        delete avisos.ml[qid];
        salvarNotificadas();
        console.log('Resposta enviada para pergunta '+qid);
      } catch(e) {
        await sendTelegram('❌ Erro ao enviar resposta: '+esc(e.response?.data?.message || e.message));
      }
    }
  } catch(e) {
    console.log('Erro processar respostas: '+e.message);
  }
  
  setTimeout(processarRespostas, 2000);
}

// Verificar perguntas a cada 5 minutos
verificarPerguntas();
setInterval(verificarPerguntas, 5 * 60 * 1000);
// Chat Shopee a cada 5 minutos (começa 1 min depois, para o token da Shopee estar pronto)
setTimeout(() => { verificarChatShopee(); setInterval(verificarChatShopee, 5 * 60 * 1000); }, 60 * 1000);

// Processar respostas continuamente
processarRespostas();

console.log('Bot Telegram ativo! Verificando perguntas a cada 5 minutos.');

module.exports = { verificarPerguntas };
