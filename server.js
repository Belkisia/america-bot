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
- Horário: seg-sex 7h às 20h, sáb 7h às 14h, dom fechado
- Endereço: Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia - GO, CEP: 74485-055
- CONSULTAS: Clínico Geral R$80, Ginecologia e Obstetrícia R$120, Endocrinologia R$120, Psiquiatria R$120, Pediatria R$100, Otorrinolaringologia R$140
- PROCEDIMENTOS: Limpeza de ouvido R$50, Inserir DIU R$400, Retirar DIU R$300, Prevenção/Citopatológico R$80, Retirada de pontos R$50
- ULTRASSOM (pergunte qual exame específico antes de informar o valor): USG Abdome Inferior R$70, USG Abdome Superior R$70, USG Abdome Total R$100, USG Mamas R$90, USG Morfológica 1 tri R$230, USG Morfológica 2 tri R$280, USG Obstétrica R$100, USG Obstétrica c Doppler R$280, USG Tireoide R$90, USG Transvaginal R$90, USG Transvaginal c Doppler R$160, USG Vias Urinárias R$80, USG Pélvica R$80, USG Parótidas R$70, USG Ombro R$90, USG Cervical R$80, Doppler Carótidas R$150, Doppler Órgão Isolado R$140

Para agendar, colete: nome completo, especialidade, particular ou convênio, período (manhã/tarde/noite).

Ao confirmar agendamento diga:
Seu atendimento foi solicitado com sucesso!
Centro Médico America - Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia - GO, CEP: 74485-055
Em breve nossa equipe confirmará o melhor horário. Será um prazer recebê-lo!

Use linguagem elegante e profissional. Nunca use Aguarde ou Ok sozinhos.
Formato WhatsApp: máximo 3 parágrafos.`;

function extrairAgendamento(texto) {
  const match = texto.match(/\[AGENDAR:([^\]]+)\]/);
  if (!match) return null;
  const dados = {};
  match[1].split('|').forEach(function(par) {
    const idx = par.indexOf('=');
    if (idx > 0) dados[par.substring(0,idx).trim()] = par.substring(idx+1).trim();
  });
  return Object.keys(dados).length >= 3 ? dados : null;
}

function removerBlocoAgendar(texto) {
  return texto.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();
}

async function chamarIA(mensagens) {
  const r = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 700, system: SYSTEM_PROMPT, messages: mensagens },
    { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
  );
  return r.data.content[0].text;
}

async function enviarZAPI(numero, texto) {
  try {
    await axios.post(
      EVOLUTION_API_URL + '/send-text',
      { phone: numero, message: texto },
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch(e) { console.error('Erro enviar:', e.message); }
}

app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('WEBHOOK:', JSON.stringify(body).substring(0, 200));

    const numero = body.phone || body.from || '';
    const texto = (body.text && body.text.message) || body.message || '';
    const fromMe = body.fromMe || body.isFromMe || false;

    if (!numero || !texto || fromMe) return;

    console.log('MSG [' + numero + ']:', texto);

    if (atendimentoHumano.has(numero)) return;

    if (texto.toLowerCase() === '#humano') {
      atendimentoHumano.add(numero);
      await enviarZAPI(numero, 'Direcionando para nossa equipe especializada. Em instantes alguém irá atendê-lo.');
      return;
    }
    if (texto === '#ia_on') { atendimentoHumano.delete(numero); return; }

    const historico = await db.buscarHistorico(numero, 20);
    await db.salvarMensagem(numero, 'user', texto);
    const msgs = historico.concat([{ role: 'user', content: texto }]);
    const resposta = await chamarIA(msgs);

    const dadosAg = extrairAgendamento(resposta);
    if (dadosAg) {
      await db.salvarAgendamento({ nome_paciente: dadosAg.nome, telefone: numero, especialidade: dadosAg.especialidade, convenio: dadosAg.convenio || 'particular', periodo: dadosAg.periodo, origem: 'whatsapp' });
      console.log('Agendamento salvo:', dadosAg.nome);
    }

    const final = removerBlocoAgendar(resposta);
    await db.salvarMensagem(numero, 'assistant', final);
    await enviarZAPI(numero, final);
    console.log('Respondido:', numero);

  } catch(e) { console.error('Erro webhook:', e.message); }
});

app.get('/api/agendamentos', async function(req, res) {
  try {
    const dados = await db.buscarAgendamentos({ status: req.query.status, limite: parseInt(req.query.limite) || 50 });
    res.json(dados);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/pacientes', async function(req, res) {
  try {
    const result = await db.supabase.from('pacientes').select('*').order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch(e) { res.status(500).json({ erro: e.message }); }
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
    const telefone = req.body.telefone || 'dashboard';
    const mensagem = req.body.mensagem;
    if (!mensagem) return res.status(400).json({ erro: 'mensagem obrigatória' });

    const historico = await db.buscarHistorico(telefone, 20);
    await db.salvarMensagem(telefone, 'user', mensagem);
    const msgs = historico.concat([{ role: 'user', content: mensagem }]);
    const resposta = await chamarIA(msgs);

    const dadosAg = extrairAgendamento(resposta);
    if (dadosAg) {
      await db.salvarAgendamento({ nome_paciente: dadosAg.nome, telefone: telefone, especialidade: dadosAg.especialidade, convenio: dadosAg.convenio || 'particular', periodo: dadosAg.periodo, origem: 'chat' });
    }

    const final = removerBlocoAgendar(resposta);
    await db.salvarMensagem(telefone, 'assistant', final);
    res.json({ resposta: final, agendamento: dadosAg || null });
  } catch(e) {
    console.error('ERRO /api/chat:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.get('/setup-zapi', async function(req, res) {
  try {
    const r = await axios.post(
      'https://api.z-api.io/instances/3F3F8C9C08E0135E5F3B6653CAD29060/token/64D60F31AD6196D01A97A0D3/update-webhook-received',
      { value: 'https://america-bot-production.up.railway.app/webhook' },
      { headers: { 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true, resultado: r.data });
  } catch(e) {
    res.json({ erro: e.message });
  }
});

app.listen(PORT, function() {
  console.log('CMA Assistente Premium v2 | Porta: ' + PORT + ' | Online');
});
