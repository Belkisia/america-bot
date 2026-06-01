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
const SYSTEM_PROMPT = `Você é a CMA, assistente executiva premium do Centro Médico America em Goiânia, GO. Perfil: elegante, sofisticada, calorosa, extremamente profissional. Jamais robótica. Jamais dá diagnósticos. Jamais inventa informações. IMPORTANTE: Quando agendamento CONFIRMADO inclua no final: [AGENDAR:nome=NOME|especialidade=ESP|convenio=CONV|periodo=PER] Informações: Especialidades: cardiologia, ortopedia, dermatologia, neurologia, ginecologia, endocrinologia, oncologia, urologia, oftalmologia, otorrinolaringologia. Convênios: Unimed, Bradesco Saúde, SulAmérica, Amil, Porto Seguro, Notre Dame Intermédica, Hapvida. Horário: seg-sex 7h-20h, sáb 7h-14h, dom fechado. Endereço: Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia-GO, CEP 74485-055. CONSULTAS: Clínico Geral R$80, Ginecologia R$120, Endocrinologia R$120, Psiquiatria R$120, Pediatria R$100, Otorrino R$140. PROCEDIMENTOS: Limpeza ouvido R$50, DIU inserir R$400, DIU retirar R$300, Prevenção R$80, Retirada pontos R$50. ULTRASSOM: pergunte qual exame antes de informar valor. Para agendar colete: nome, especialidade, convênio/particular, período. Ao confirmar diga: Atendimento solicitado com sucesso! Centro Médico America - Av. Frei Miguelino 247, Goiânia-GO. Em breve confirmamos o horário.`;
function extrairAgendamento(t) {
  const m = t.match(/\[AGENDAR:([^\]]+)\]/);
  if (!m) return null;
  const d = {};
  m[1].split('|').forEach(function(p) { const i = p.indexOf('='); if (i > 0) d[p.substring(0,i).trim()] = p.substring(i+1).trim(); });
  return Object.keys(d).length >= 3 ? d : null;
}
function limpar(t) { return t.replace(/\[AGENDAR:[^\]]+\]/g, '').trim(); }
async function chamarIA(msgs) {
  const r = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-sonnet-4-6', max_tokens: 700, system: SYSTEM_PROMPT, messages: msgs }, { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
  return r.data.content[0].text;
}
async function enviar(numero, texto) {
  try {
    await axios.post(EVOLUTION_API_URL + '/send-text', { phone: numero, message: texto }, { headers: { 'Content-Type': 'application/json' } });
  } catch(e) { console.error('Erro enviar:', e.message); }
}
app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    const b = req.body;
    console.log('WH:', JSON.stringify(b).substring(0, 150));
    const num = b.phone || b.from || '';
    const txt = (b.text && b.text.message) || b.message || '';
    if (!num || !txt || b.fromMe) return;
    if (atendimentoHumano.has(num)) return;
    if (txt.toLowerCase() === '#humano') { atendimentoHumano.add(num); await enviar(num, 'Direcionando para nossa equipe.'); return; }
    if (txt === '#ia_on') { atendimentoHumano.delete(num); return; }
    const hist = await db.buscarHistorico(num, 20);
    await db.salvarMensagem(num, 'user', txt);
    const resp = await chamarIA(hist.concat([{ role: 'user', content: txt }]));
    const ag = extrairAgendamento(resp);
    if (ag) await db.salvarAgendamento({ nome_paciente: ag.nome, telefone: num, especialidade: ag.especialidade, convenio: ag.convenio || 'particular', periodo: ag.periodo, origem: 'whatsapp' });
    const final = limpar(resp);
    await db.salvarMensagem(num, 'assistant', final);
    await enviar(num, final);
  } catch(e) { console.error('WH err:', e.message); }
});
app.get('/setup-zapi', async function(req, res) {
  try {
    const r = await axios.put('https://api.z-api.io/instances/3F3F8C9C08E0135E5F3B6653CAD29060/token/64D60F31AD6196D01A97A0D3/update-webhook-received', { value: { url: 'https://america-bot-production.up.railway.app/webhook' }, { headers: { 'Content-Type': 'application/json' } });
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
    const hist = await db.buscarHistorico(tel, 20);
    await db.salvarMensagem(tel, 'user', msg);
    const resp = await chamarIA(hist.concat([{ role: 'user', content: msg }]));
    const ag = extrairAgendamento(resp);
    if (ag) await db.salvarAgendamento({ nome_paciente: ag.nome, telefone: tel, especialidade: ag.especialidade, convenio: ag.convenio || 'particular', periodo: ag.periodo, origem: 'chat' });
    const final = limpar(resp);
    await db.salvarMensagem(tel, 'assistant', final);
    res.json({ resposta: final, agendamento: ag || null });
  } catch(e) { console.error('CHAT err:', e.message); res.status(500).json({ erro: e.message }); }
});
app.get('/', function(req, res) { res.json({ status: 'online', agente: 'CMA v2', uptime: Math.floor(process.uptime()) + 's' }); });
app.listen(PORT, function() { console.log('CMA Assistente Premium v2 | Porta: ' + PORT + ' | Online'); });
