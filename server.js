const express = require('express');
const axios = require('axios');
const db = require('./supabase');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const PORT = process.env.PORT || 3000;

const atendimentoHumano = new Set();

const SYSTEM_PROMPT = `Você é a CMA, assistente executiva premium do Centro Médico America em Goiânia, GO.

Perfil: elegante, sofisticada, calorosa, extremamente profissional. Jamais robótica. Jamais dá diagnósticos. Jamais inventa informações.

IMPORTANTE — Quando um agendamento for CONFIRMADO (nome, especialidade e período fornecidos), inclua no final da resposta:
[AGENDAR:nome=NOME_COMPLETO|especialidade=ESPECIALIDADE|convenio=CONVENIO|periodo=PERIODO]

Informações da clínica:
- Especialidades: cardiologia, ortopedia, dermatologia, neurologia, ginecologia, endocrinologia, oncologia, urologia, oftalmologia, otorrinolaringologia
- Convênios: Unimed, Bradesco Saúde, SulAmérica, Amil, Porto Seguro, Notre Dame Intermédica, Hapvida
- Horário: seg-sex 7h às 20h · sáb 7h às 14h · dom fechado
- Endereço: Av. Frei Miguelino, 247 – Bairro Goiá, Goiânia – GO, CEP: 74485-055
- CONSULTAS: Clínico Geral R$80 · Ginecologia e Obstetrícia R$120 · Endocrinologia R$120 · Psiquiatria R$120 · Pediatria R$100 · Otorrinolaringologia R$140
- PROCEDIMENTOS: Limpeza de ouvido R$50 · Inserir DIU R$400 · Retirar DIU R$300 · Prevenção/Citopatológico R$80 · Retirada de pontos R$50
- ULTRASSOM (pergunte qual exame específico antes de informar o valor): USG Abdome Inferior R$70 · USG Abdome Superior R$70 · USG Abdome Total R$100 · USG Mamas R$90 · USG Morfológica 1º tri R$230 · USG Morfológica 2º tri R$280 · USG Obstétrica R$100 · USG Obstétrica c/ Doppler R$280 · USG Tireoide R$90 · USG Transvaginal R$90 · USG Transvaginal c/ Doppler R$160 · USG Vias Urinárias R$80 · USG Pélvica R$80 · USG Parótidas R$70 · USG Ombro R$90 · USG Cervical R$80 · Doppler Carótidas R$150 · Doppler Órgão Isolado R$140

Para agendar, colete: nome completo, especialidade, particular ou convênio, período (manhã/tarde/noite).

Ao confirmar o agendamento:
"Seu atendimento foi solicitado com sucesso! ✅
📍 Centro Médico America
Av. Frei Miguelino, 247 – Bairro Goiá
Goiânia – GO · CEP: 74485-055
📌 https://maps.google.com/?q=Av.+Frei+Miguelino,+247,+Goiânia
Em breve nossa equipe confirmará o melhor horário disponível. Será um prazer recebê-lo(a)! 😊"

Use: "Será um prazer auxiliá-lo" · Nunca use "Aguarde" ou "Ok" sozinhos.
Formato WhatsApp: máximo 3 parágrafos, bullets apenas ao listar.`;

function extrairAgendamento(texto) {
  const match = texto.match(/\[AGENDAR:([^\]]+)\]/);
  if (!match) return null;
  const dados = {};
  match[1].split('|').forEach(par => {
    const idx = par.indexOf('=');
    if (idx > 0) dados[par.substring(0,idx).trim()] = par.substring(idx+1).trim();
  });
  return Object.keys(dados).length >= 3 ? dados : null;
}

function removerBlocoAgendar(texto) {
  return texto.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();
}

async function chamarAmerica(telefone, mensagemUsuario) {
  const historico = await db.buscarHistorico(telefone, 20);
  await db.salvarMensagem(telefone, 'user', mensagemUsuario);
  await db.logMensagem(telefone, mensagemUsuario, 'recebida');
  const mensagens = [...historico, { role: 'user', content: mensagemUsuario }];
  const resposta = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 700, system: SYSTEM_PROMPT, messages: mensagens },
    { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
  );
  const textoCompleto = resposta.data.content[0].text;
  const dadosAgendamento = extrairAgendamento(textoCompleto);
  if (dadosAgendamento) {
    try {
      await db.salvarAgendamento({ nome_paciente: dadosAgendamento.nome, telefone, especialidade: dadosAgendamento.especialidade, convenio: dadosAgendamento.convenio || 'particular', periodo: dadosAgendamento.periodo, origem: 'whatsapp' });
      console.log('Agendamento salvo:', dadosAgendamento.nome, '-', dadosAgendamento.especialidade);
    } catch (e) { console.error('Erro ao salvar agendamento:', e.message); }
  }
  const textoFinal = removerBlocoAgendar(textoCompleto);
  await db.salvarMensagem(telefone, 'assistant', textoFinal);
  await db.logMensagem(telefone, textoFinal, 'enviada');
  return textoFinal;
}

async function enviarMensagemZAPI(numero, texto) {
  try {
    await axios.post(
      `${EVOLUTION_API_URL}/send-text`,
      { phone: numero, message: texto },
      { headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN || '' } }
    );
  } catch (e) { console.error('Erro enviar WA:', e.message); }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('WEBHOOK:', JSON.stringify(body).substring(0, 300));
    
    // Formato Z-API
    const numero = body.phone || body.from || '';
    const texto = body.text?.message || body.message?.text || body.message || '';
    const fromMe = body.fromMe || body.isFromMe || false;
    
    if (!numero || !texto || fromMe) return;
    
    console.log('MSG [' + numero + ']:', texto);
    
    if (atendimentoHumano.has(numero)) return;
    
    if (texto.toLowerCase() === '#humano') {
      atendimentoHumano.add(numero);
      await enviarMensagemZAPI(numero, 'Direcionando para nossa equipe especializada. Em instantes alguém irá atendê-lo. 🌟');
      return;
    }
    if (texto === '#ia_on') { atendimentoHumano.delete(numero); return; }
    
    const resposta = await chamarAmerica(numero, texto);
    await enviarMensagemZAPI(numero, resposta);
    console.log('Respondido:', numero);
    
  } catch (e) { console.error('Erro webhook:', e.message); }
});
    console.log('WEBHOOK RECEBIDO:', JSON.stringify(body).substring(0, 200));
    const numero = body.phone || body.from;
    const texto = body.text?.message || body.message || '';
    if (!numero || !texto.trim()) return;
    if (body.fromMe) return;
    console.log('WA [' + numero + ']:', texto);
    if (atendimentoHumano.has(numero)) return;
    if (texto.toLowerCase() === '#humano') {
      atendimentoHumano.add(numero);
      await enviarMensagemZAPI(numero, 'Direcionando para nossa equipe especializada. Em instantes alguém irá atendê-lo. 🌟');
      return;
    }
    if (texto === '#ia_on') { atendimentoHumano.delete(numero); return; }
    const resposta = await chamarAmerica(numero, texto);
    await enviarMensagemZAPI(numero, resposta);
  } catch (e) { console.error('Erro webhook:', e.message); }
});

app.get('/api/agendamentos', async (req, res) => {
  try {
    const dados = await db.buscarAgendamentos({ status: req.query.status, limite: parseInt(req.query.limite) || 50 });
    res.json(dados);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/pacientes', async (req, res) => {
  try {
    const result = await db.supabase.from('pacientes').select('*').order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { console.error('ERRO /api/pacientes:', e.message); res.status(500).json({ erro: e.message }); }
});

app.patch('/api/agendamentos/:id', async (req, res) => {
  try { await db.atualizarStatus(req.params.id, req.body.status); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/metricas', async (req, res) => {
  try { res.json(await db.buscarMetricas()); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { telefone = 'dashboard', mensagem } = req.body;
    if (!mensagem) return res.status(400).json({ erro: 'mensagem obrigatória' });
    const historico = await db.buscarHistorico(telefone, 20);
    await db.salvarMensagem(telefone, 'user', mensagem);
    const msgs = [...historico, { role: 'user', content: mensagem }];
    const resposta = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 700, system: SYSTEM_PROMPT, messages: msgs },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
    );
    const textoCompleto = resposta.data.content[0].text;
    const dadosAgendamento = extrairAgendamento(textoCompleto);
    if (dadosAgendamento) {
      await db.salvarAgendamento({ nome_paciente: dadosAgendamento.nome, telefone, especialidade: dadosAgendamento.especialidade, convenio: dadosAgendamento.convenio || 'particular', periodo: dadosAgendamento.periodo, origem: 'chat' });
    }
    const textoFinal = removerBlocoAgendar(textoCompleto);
    await db.salvarMensagem(telefone, 'assistant', textoFinal);
    res.json({ resposta: textoFinal, agendamento: dadosAgendamento || null });
  } catch (e) { console.error('ERRO /api/chat:', e.message); res.status(500).json({ erro: e.message }); }
});

app.get('/', (req, res) => {
  res.json({ status: 'online', agente: 'CMA Assistente Premium v2', uptime: Math.floor(process.uptime()) + 's' });
});

app.listen(PORT, () => {
  console.log('CMA Assistente Premium v2 | Porta: ' + PORT + ' | Online');
});
