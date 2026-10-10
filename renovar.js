const https = require('https');
// Credenciais vêm do .env / variáveis de ambiente (nunca fixas no código)
try { for (const l of require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([^#=]+)=(.*)$/); if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch (e) {}
const fs = require('fs');

const CONTAS = [
  { nome: 'Zagodini', cid: process.env.ML_ZAGODINI_CID, secret: process.env.ML_ZAGODINI_SECRET },
  { nome: 'Mae',      cid: process.env.ML_MAE_CID,      secret: process.env.ML_MAE_SECRET },
  { nome: 'Lufe',     cid: process.env.ML_LUFE_CID,     secret: process.env.ML_LUFE_SECRET },
];

function renovarToken(conta, refresh) {
  return new Promise((resolve, reject) => {
    const data = 'grant_type=refresh_token&client_id='+conta.cid+'&client_secret='+conta.secret+'&refresh_token='+refresh;
    const req = https.request({
      hostname: 'api.mercadolibre.com',
      path: '/oauth/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.access_token) {
            console.log(new Date().toLocaleTimeString('pt-BR') + ' - ' + conta.nome + ': token renovado!');
            resolve({ token: j.access_token, refresh: j.refresh_token });
          } else {
            console.log(conta.nome + ' erro: ' + b);
            reject(b);
          }
        } catch(e) { reject(e); }
      });
    });
    req.write(data);
    req.end();
  });
}

async function renovarTodos() {
  try {
    const tokens = JSON.parse(fs.readFileSync(require('path').join(require('./dados'), 'tokens.json')));
    for (const conta of CONTAS) {
      try {
        const novo = await renovarToken(conta, tokens[conta.nome].refresh);
        tokens[conta.nome] = novo;
      } catch(e) {
        console.log('Erro ao renovar ' + conta.nome + ': ' + e);
      }
    }
    fs.writeFileSync(require('path').join(require('./dados'), 'tokens.json'), JSON.stringify(tokens, null, 2));
    console.log(new Date().toLocaleTimeString('pt-BR') + ' - tokens.json atualizado!');
  } catch(e) {
    console.log('Erro geral: ' + e);
  }
}

// Renovar imediatamente e depois a cada 5 horas
renovarTodos();
setInterval(renovarTodos, 5 * 60 * 60 * 1000);
console.log('Sistema de renovacao automatica ativo! Renovando a cada 5 horas.');
