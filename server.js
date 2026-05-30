require('dotenv').config();
const express = require('express');
const axios = require('axios');
const db = require('./supabase');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const { ANTHROPIC_API_KEY, EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE, PORT = 3000 } = process.env;
const atendimentoHumano = new Set();

const SYSTEM_PROMPT = `Você é a América, assistente executiva premium do Centro Médico America em São Paulo.

Perfil: elegante, sofisticada, calorosa, extremamente profissional. Jamais robótica. Jamais dá diagnósticos. Jamais inventa informações.

IMPORTANTE — Detecção de agendamento:
Quando um agendamento for CONFIRMADO pelo paciente (ele forneceu nome, especialidade e período), inclua no final da resposta:
[AGENDAR:nome=NOME_COMPLETO|especialidade=ESPECIALIDADE|convenio=CONVENIO|periodo=PERIODO]
Só inclua quando o paciente tiver fornecido TODOS os dados e confirmado.

Informações da clínica:
- Especialidades: cardiologia, ortopedia, dermatologia, neurologia, ginecologia, endocrinologia, oncologia, urologia, oftalmologia, otorrinolaringologia
- Convênios: Unimed, Bradesco Saúde, SulAmérica, Amil, Porto Seguro, Notre Dame Intermédica, Hapvida
- Horário: seg-sex 7h às 20h · sáb 7h às 14h · dom fechado
- Endereço: Av. Paulista, 1234 — São Paulo/SP · Estacionamento disponível
- Exames (particular): hemograma R$45 · glicemia R$25 · colesterol R$35 · ressonância a partir de R$850 · tomografia a partir de R$450 · raio-x R$120 · ultrassom R$180 · ecocardiograma R$380 · eletrocardiograma R$95

Para agendar, colete em ordem: 1. Nome completo 2. Especialidade 3. Particular ou convênio 4. Período (manhã, tarde ou noite)

Comunicação premium: use "Será um prazer auxiliá-lo", nunca use "Aguarde" ou "Ok" sozinhos.
Formato WhatsApp: máximo 3 parágrafos, bullets apenas ao listar.`;

function extrairAgendamento(texto) {
  const match = texto.match(/\[AGENDAR:([^\]]+)\]/);
  if (!match) return null;
  const dados = {};
  match[1].split('|').forEach(par => { const [c, v] = par.split('='); if (c && v) dados[c.trim()] = v.trim(); });
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
  const resposta = await axios.post('https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: 700, system: SYSTEM_PROMPT, messages: mensagens },
    { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
  );
  const textoCompleto = resposta.data.content[0].text;
  const dadosAgendamento = extrairAgendamento(textoCompleto);
  if (dadosAgendamento) {
    try {
      await db.salvarAgendamento({ nome_paciente: dadosAgendamento.nome, telefone, especialidade: dadosAgendamento.especialidade, convenio: dadosAgendamento.convenio || 'particular', periodo: dadosAgendamento.periodo, origem: 'whatsapp' });
      console.log(`📅 Agendamento salvo: ${dadosAgendamento.nome} — ${dadosAgendamento.especialidade}`);
    } catch (e) { console.error('Erro ao salvar agendamento:', e.message); }
  }
  const textoFinal = removerBlocoAgendar(textoCompleto);
  await db.salvarMensagem(telefone, 'assistant', textoFinal);
  await db.logMensagem(telefone, textoFinal, 'enviada');
  return textoFinal;
}

async function enviarMensagem(numero, texto) {
  await axios.post(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
    { number: numero, text: texto },
    { headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY } }
  );
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.event !== 'messages.upsert') return;
    const dados = body.data;
    if (!dados?.key || dados.key.fromMe || dados.key.remoteJid?.includes('@g.us')) return;
    const numero = dados.key.remoteJid?.replace('@s.whatsapp.net', '');
    if (!numero) return;
    const texto = dados.message?.conversation || dados.message?.extendedTextMessage?.text || dados.message?.imageMessage?.caption || '';
    if (!texto.trim()) return;
    console.log(`📩 [${numero}] ${texto}`);
    if (atendimentoHumano.has(numero)) return;
    if (texto.toLowerCase() === '#humano') {
      atendimentoHumano.add(numero);
      await enviarMensagem(numero + '@s.whatsapp.net', 'Estou direcionando seu atendimento para nossa equipe especializada. Em instantes alguém irá atendê-lo. 🌟');
      return;
    }
    if (texto === '#ia_on') { atendimentoHumano.delete(numero); return; }
    const resposta = await chamarAmerica(numero, texto);
    await enviarMensagem(numero + '@s.whatsapp.net', resposta);
    console.log(`✅ [${numero}] Respondido`);
  } catch (erro) { console.error('Erro no webhook:', erro.message); }
});

app.get('/api/agendamentos', async (req, res) => {
  try { const { status, limite = 50 } = req.query; res.json(await db.buscarAgendamentos({ status, limite: parseInt(limite) })); }
  catch (e) { res.status(500).json({ erro: e.message }); }
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
    const historico = await db.buscarHistorico(telefone, 20);
    await db.salvarMensagem(telefone, 'user', mensagem);
    const msgs = [...historico, { role: 'user', content: mensagem }];
    const resposta = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-20250514', max_tokens: 700, system: SYSTEM_PROMPT, messages: msgs },
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
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/', (req, res) => {
  res.json({ status: 'online', agente: 'América Assistente Premium v2', banco: 'Supabase conectado', uptime: Math.floor(process.uptime()) + 's' });
});

app.listen(PORT, () => console.log(`América Assistente v2 · Porta ${PORT} · Online`));
