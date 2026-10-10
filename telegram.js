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

// Perguntas já notificadas (evita duplicatas)
let notificadas = new Set();
try { notificadas = new Set(JSON.parse(fs.readFileSync('notificadas.json'))); } catch(e) {}

function salvarNotificadas() {
  fs.writeFileSync('notificadas.json', JSON.stringify([...notificadas]));
}

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
      res.on('end', () => resolve(JSON.parse(b)));
    });
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
      const perg = await axios.get(BASE_ML+'/questions/search?seller_id='+uid+'&status=UNANSWERED&limit=20', { headers: { Authorization: 'Bearer '+token } });
      const qs = perg.data.questions || [];
      
      for (const q of qs) {
        if (notificadas.has(q.id)) continue;
        notificadas.add(q.id);
        salvarNotificadas();
        
        // Buscar titulo do anuncio
        let titulo = q.item_id;
        try {
          const item = await axios.get(BASE_ML+'/items/'+q.item_id+'?attributes=title', { headers: { Authorization: 'Bearer '+token } });
          titulo = item.data.title;
        } catch(e) {}
        
        const msg = '❓ <b>Nova pergunta - '+conta.nome+'</b>\n\n'+
          '📦 <b>Produto:</b> '+titulo+'\n'+
          '🆔 <b>ID:</b> '+q.item_id+'\n'+
          '❓ <b>Pergunta:</b> '+q.text+'\n\n'+
          '💬 <i>Responda esta mensagem com sua resposta para postar no ML automaticamente!</i>\n'+
          '🔑 <code>QID:'+q.id+'|IDX:'+conta.idx+'</code>';
        
        await sendTelegram(msg);
        console.log('Pergunta notificada: '+q.id);
      }
    } catch(e) {
      console.log('Erro verificar perguntas '+conta.nome+': '+e.message);
    }
  }
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
      
      // Verificar se é resposta a uma pergunta do ML
      const texto = msg.reply_to_message.text || '';
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
        
        await sendTelegram('✅ <b>Resposta enviada com sucesso!</b>\n\n<i>'+resposta+'</i>');
        notificadas.delete(qid);
        salvarNotificadas();
        console.log('Resposta enviada para pergunta '+qid);
      } catch(e) {
        await sendTelegram('❌ Erro ao enviar resposta: '+e.message);
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

// Processar respostas continuamente
processarRespostas();

console.log('Bot Telegram ativo! Verificando perguntas a cada 5 minutos.');

module.exports = { verificarPerguntas };
