const express = require('express');
const axios = require('axios');
const db = require('./supabase');
const app = express();
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const PORT = process.env.PORT || 3000;
const atendimentoHumano = new Set();
const NUMEROS_IGNORAR = ['556284271335'];

const SYSTEM_PROMPT = `Você é a CMA, assistente executiva do Centro Médico America em Goiânia, GO. Elegante, profissional, calorosa. Jamais dá diagnósticos. Jamais inventa informações.

REGRA CRÍTICA: Leia TODO o histórico antes de responder. NUNCA reinicie a conversa se já há mensagens. NUNCA peça dados que o paciente já forneceu.

AGENDAMENTO: Quando todos os dados forem confirmados, inclua no final: [AGENDAR:nome=NOME|especialidade=ESP|convenio=particular|periodo=PER]
A clínica atende SOMENTE particular. NUNCA pergunte sobre convênio.
Para agendar colete: nome completo, especialidade, período (manhã ou tarde).

Especialidades: cardiologia, ortopedia, dermatologia, neurologia, ginecologia, endocrinologia, oncologia, urologia, oftalmologia, otorrinolaringologia.
Horário: seg-sex 7h-20h, sáb 7h-14h.
Endereço: Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia-GO, CEP 74485-055.
CONSULTAS: Clínico Geral R$80, Ginecologia R$120, Endocrinologia R$120, Psiquiatria R$120, Pediatria R$100, Otorrino R$140.
PROCEDIMENTOS: Limpeza ouvido R$50, DIU inserir R$400, DIU retirar R$300, Prevenção R$80, Retirada pontos R$50.
ULTRASSOM (informe o valor quando o paciente especificar): USG Abdome Inferior R$70, USG Abdome Inferior c/Doppler R$160, USG Abdome Superior R$70, USG Abdome Superior c/Doppler R$160, USG Abdome Total R$100, USG Abdome Total c/Doppler R$350, USG Articulação R$80, USG Bolsa Escrotal R$80, USG Bolsa Escrotal c/Doppler R$150, USG Mamas R$90, USG Morfológica 1º Trimestre R$230, USG Morfológica 2º Trimestre R$280, USG Obstétrica acima 14 semanas R$100, USG Obstétrica c/Doppler R$280, USG Obstétrica Endovaginal R$100, USG Obstétrica Gestação Múltipla R$180, USG Partes Moles R$70, USG Próstata Via Abdominal R$90, USG Quadril Pediátrico cada lado R$80, USG Tireoide R$90, USG Tireoide c/Doppler R$150, USG Transvaginal R$90, USG Transvaginal c/Doppler R$160, USG Vias Urinárias e Rins R$80, USG Transfontanela R$130, USG Pélvica R$80, USG Punho cada lado R$80, USG Parede Abdominal R$80, USG Parótidas R$70, USG Parótidas c/Doppler R$160, USG Pé cada lado R$80, USG Quadril Adulto cada lado R$80, USG Orelha cada lado R$70, USG Cervical R$80, USG Ombro cada lado R$90, USG Região Inguinal cada lado R$80, Doppler Órgão ou Estrutura Isolada R$140, Doppler Carótidas e Vertebrais R$150.
Ao confirmar: Seu atendimento foi solicitado! 

📍 Centro Médico America
Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia-GO, CEP 74485-055
🗺 https://maps.google.com/?q=Av.+Frei+Miguelino,+247,+Goiânia

Em breve nossa equipe confirmará o horário. Será um prazer recebê-lo(a)!
Formato: máximo 3 parágrafos curtos, sem # markdown.`;

function extrairAgendamento(t) {
  const m = t.match(/\[AGENDAR:([^\]]+)\]/);
  if (!m) return null;
  const d = {};
  m[1].split('|').forEach(function(p) { const i = p.indexOf('='); if (i > 0) d[p.substring(0,i).trim()] = p.substring(i+1).trim(); });
  return Object.keys(d).length >= 3 ? d : null;
}
function limpar(t) { return t.replace(/\[AGENDAR:[^\]]+\]/g, '').trim(); }

async function chamarIA(msgs) {
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 600, system: SYSTEM_PROMPT, messages: msgs },
    { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 25000 }
  );
  return r.data.content[0].text;
}

async function enviar(numero, texto) {
  try {
    await axios.post(EVOLUTION_API_URL, { phone: numero, message: texto },
      { headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN }, timeout: 10000 }
    );
  } catch(e) { console.error('Erro enviar:', e.message); }
}

// Fila independente por número
const filas = {};

function enfileirar(num, txt) {
  if (!filas[num]) filas[num] = { msgs: [], rodando: false };
  filas[num].msgs.push(txt);
  if (!filas[num].rodando) processarFila(num);
}

async function processarFila(num) {
  if (!filas[num] || filas[num].msgs.length === 0) {
    if (filas[num]) filas[num].rodando = false;
    return;
  }
  filas[num].rodando = true;

  // Aguarda 2s para agrupar mensagens rápidas
  await new Promise(function(r) { setTimeout(r, 2000); });

  const msgs = filas[num].msgs.splice(0);
  const txtCompleto = msgs.join(' ').trim();

  try {
    console.log('PROC [' + num + ']:', txtCompleto);
    if (atendimentoHumano.has(num)) { processarFila(num); return; }
    if (txtCompleto.toLowerCase() === '#humano') {
      atendimentoHumano.add(num);
      await enviar(num, 'Direcionando para nossa equipe especializada. Em instantes alguém irá atendê-lo.');
      processarFila(num);
      return;
    }
    if (txtCompleto === '#ia_on') { atendimentoHumano.delete(num); processarFila(num); return; }

    await db.salvarMensagem(num, 'user', txtCompleto);
    let hist = await db.buscarHistorico(num, 10);
    if (hist.length === 0 || hist[hist.length - 1].role !== 'user') {
      hist.push({ role: 'user', content: txtCompleto });
    }

    const resp = await chamarIA(hist);
    const ag = extrairAgendamento(resp);
    if (ag) {
      await db.salvarAgendamento({ nome_paciente: ag.nome, telefone: num, especialidade: ag.especialidade, convenio: 'particular', periodo: ag.periodo, origem: 'whatsapp' });
      console.log('AGENDADO:', ag.nome, ag.especialidade);
    }
    const final = limpar(resp);
    await db.salvarMensagem(num, 'assistant', final);
    await enviar(num, final);
    console.log('OK [' + num + ']');
  } catch(e) {
    console.error('ERRO [' + num + ']:', e.message);
  }

  processarFila(num);
}

// Webhook
const webhookLogs = [];
app.get('/webhook', function(req, res) { res.sendStatus(200); });
app.post('/webhook', function(req, res) {
  res.sendStatus(200);
  webhookLogs.unshift({ time: new Date().toISOString(), phone: req.body.phone, text: req.body.text && req.body.text.message });
  if (webhookLogs.length > 30) webhookLogs.pop();

  const b = req.body;
  if (b.type !== 'ReceivedCallback') return;
  if (b.isGroup) return;
  const num = b.phone || '';
  if (!num || num.includes('@lid') || num.includes('-group')) return;
  if (NUMEROS_IGNORAR.includes(num)) return;
  const txt = (b.text && b.text.message) || '';
  if (!txt.trim()) return;
  if (b.fromMe || b.fromApi) return;

  enfileirar(num, txt);
});

app.get('/webhook-logs', function(req, res) { res.json(webhookLogs); });

app.get('/setup-zapi', async function(req, res) {
  try {
    const r = await axios.put(
      'https://api.z-api.io/instances/3F3F8C9C08E0135E5F3B6653CAD29060/token/64D60F31AD6196D01A97A0D3/update-webhook-received',
      { value: 'https://america-bot.onrender.com/webhook' },
      { headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN } }
    );
    res.json({ ok: true, resultado: r.data });
  } catch(e) { res.json({ erro: e.message }); }
});

app.get('/api/agendamentos', async function(req, res) {
  try { res.json(await db.buscarAgendamentos({ status: req.query.status, limite: parseInt(req.query.limite) || 50 })); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.get('/api/pacientes', async function(req, res) {
  try { const r = await db.supabase.from('pacientes').select('*').order('created_at', { ascending: false }); res.json(r.data || []); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.patch('/api/agendamentos/:id', async function(req, res) {
  try { await db.atualizarStatus(req.params.id, req.body.status); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.get('/api/metricas', async function(req, res) {
  try { res.json(await db.buscarMetricas()); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/chat', async function(req, res) {
  try {
    const tel = req.body.telefone || 'dashboard';
    const msg = req.body.mensagem;
    if (!msg) return res.status(400).json({ erro: 'mensagem obrigatória' });
    await db.salvarMensagem(tel, 'user', msg);
    let hist = await db.buscarHistorico(tel, 10);
    if (hist.length === 0 || hist[hist.length-1].role !== 'user') hist.push({ role: 'user', content: msg });
    const resp = await chamarIA(hist);
    const ag = extrairAgendamento(resp);
    if (ag) await db.salvarAgendamento({ nome_paciente: ag.nome, telefone: tel, especialidade: ag.especialidade, convenio: 'particular', periodo: ag.periodo, origem: 'chat' });
    const final = limpar(resp);
    await db.salvarMensagem(tel, 'assistant', final);
    res.json({ resposta: final, agendamento: ag || null });
  } catch(e) { console.error('CHAT:', e.message); res.status(500).json({ erro: e.message }); }
});
app.get('/', function(req, res) { res.json({ status: 'online', agente: 'CMA v2', uptime: Math.floor(process.uptime()) + 's' }); });
app.listen(PORT, function() { console.log('CMA Assistente Premium v2 | Porta: ' + PORT + ' | Online'); });
