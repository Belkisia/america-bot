const express = require('express');
const axios = require('axios');
const db = require('./supabase');
const app = express();
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const PORT = process.env.PORT || 3000;
const NUMEROS_IGNORAR = ['556284271335'];

// Verifica se número está em atendimento humano (com cache local de 30s)
const cacheHumano = {};
async function emAtendimentoHumano(num) {
  const agora = Date.now();
  if (cacheHumano[num] && cacheHumano[num].expira > agora) return cacheHumano[num].valor;
  const { data } = await db.supabase.from('atendimento_humano').select('expira_em').eq('telefone', num).single();
  const ativo = data && new Date(data.expira_em) > new Date();
  cacheHumano[num] = { valor: ativo, expira: agora + 30000 };
  return ativo;
}

async function ativarHumano(num, minutos) {
  const expira = new Date(Date.now() + minutos * 60 * 1000).toISOString();
  await db.supabase.from('atendimento_humano').upsert({ telefone: num, expira_em: expira });
  cacheHumano[num] = { valor: true, expira: Date.now() + 30000 };
}

async function desativarHumano(num) {
  await db.supabase.from('atendimento_humano').delete().eq('telefone', num);
  cacheHumano[num] = { valor: false, expira: Date.now() + 30000 };
}

const SYSTEM_PROMPT = `Você é a CMA, assistente executiva do Centro Médico America em Goiânia, GO. Elegante, profissional, calorosa. Jamais dá diagnósticos. Jamais inventa informações.

REGRA CRÍTICA: Leia TODO o histórico antes de responder. NUNCA reinicie a conversa se já há mensagens. NUNCA peça dados que o paciente já forneceu.

AGENDAMENTO: Quando todos os dados forem confirmados, inclua no final: [AGENDAR:nome=NOME|especialidade=ESP|convenio=particular|periodo=PER]
A clínica atende SOMENTE particular. NUNCA pergunte sobre convênio.
Para agendar colete: nome completo, especialidade, período (manhã ou tarde).

Especialidades: Clínico Geral, Endocrinologia, Ginecologia, Otorrinolaringologia, Pediatria, Psiquiatria.

AGENDA DOS MÉDICOS (informe sempre ao paciente):
• Psiquiatria: 10/06 e 24/06 das 13h30 às 17h30
• Endocrinologia: 16/06 e 30/06 das 14h00 às 17h30
• Otorrinolaringologia: 16/06 e 30/06 das 08h00 às 11h30
• Ultrassom: toda terça das 07h30 às 11h30 | toda sexta 07h30 às 09h30 e 17h00 às 18h00
• Ginecologia: segundas — 08/06, 22/06 e 29/06 das 13h00 às 17h30
Horário: seg-sex 7h30-17h30, sáb e dom fechado.
Endereço: Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia-GO, CEP 74485-055.
CONSULTAS: Clínico Geral R$80, Ginecologia R$120, Endocrinologia R$120, Psiquiatria R$120, Pediatria R$100, Otorrino R$140.
PROCEDIMENTOS: Limpeza ouvido R$50, DIU inserir R$400, DIU retirar R$300, Prevenção R$80, Retirada pontos R$50.
ULTRASSOM (informe o valor quando o paciente especificar): USG Abdome Inferior R$70, USG Abdome Inferior c/Doppler R$160, USG Abdome Superior R$70, USG Abdome Superior c/Doppler R$160, USG Abdome Total R$100, USG Abdome Total c/Doppler R$350, USG Articulação R$80, USG Bolsa Escrotal R$80, USG Bolsa Escrotal c/Doppler R$150, USG Mamas R$90, USG Morfológica 1º Trimestre R$230, USG Morfológica 2º Trimestre R$280, USG Obstétrica acima 14 semanas R$100, USG Obstétrica c/Doppler R$280, USG Obstétrica Endovaginal R$100, USG Obstétrica Gestação Múltipla R$180, USG Partes Moles R$70, USG Próstata Via Abdominal R$90, USG Quadril Pediátrico cada lado R$80, USG Tireoide R$90, USG Tireoide c/Doppler R$150, USG Transvaginal R$90, USG Transvaginal c/Doppler R$160, USG Vias Urinárias e Rins R$80, USG Transfontanela R$130, USG Pélvica R$80, USG Punho cada lado R$80, USG Parede Abdominal R$80, USG Parótidas R$70, USG Parótidas c/Doppler R$160, USG Pé cada lado R$80, USG Quadril Adulto cada lado R$80, USG Orelha cada lado R$70, USG Cervical R$80, USG Ombro cada lado R$90, USG Região Inguinal cada lado R$80, Doppler Órgão ou Estrutura Isolada R$140, Doppler Carótidas e Vertebrais R$150.
Ao confirmar: *Seu atendimento foi solicitado com sucesso!* ✅

📍 *Centro Médico America*
Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia-GO, CEP 74485-055
🗺 https://maps.google.com/?q=Av.+Frei+Miguelino,+247,+Goiânia

📞 *Em breve nossa equipe entrará em contato pelo WhatsApp para confirmar o dia e horário exato do seu atendimento.*
Será um prazer recebê-lo(a)! 😊
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

// ── Detecta se o webhook é uma mensagem de áudio/ptt ──
function detectarAudio(b) {
  // Z-API envia áudio com type "audio" ou "ptt" (push-to-talk)
  // O campo pode vir em b.type, b.messageType ou dentro de b.audio
  if (b.audio) return true;
  if (b.messageType === 'audioMessage') return true;
  if (b.messageType === 'pttMessage') return true;
  if (b.type === 'audio') return true;
  if (b.type === 'ptt') return true;
  return false;
}

// Fila independente por número
const filas = {};

function enfileirar(num, txt) {
  if (!filas[num]) filas[num] = { msgs: [], rodando: false };
  filas[num].msgs.push(txt);
  if (!filas[num].rodando) processarFila(num);
}

// Enfileira áudio diretamente (não agrupa com texto)
function enfileirarAudio(num) {
  if (!filas[num]) filas[num] = { msgs: [], rodando: false };
  filas[num].msgs.push('__AUDIO__');
  if (!filas[num].rodando) processarFila(num);
}

async function processarFila(num) {
  if (!filas[num] || filas[num].msgs.length === 0) {
    if (filas[num]) filas[num].rodando = false;
    return;
  }
  filas[num].rodando = true;

  await new Promise(function(r) { setTimeout(r, 2000); });

  const msgs = filas[num].msgs.splice(0);
  const txtCompleto = msgs.join(' ').trim();

  try {
    console.log('PROC [' + num + ']:', txtCompleto);

    // ── Tratamento de áudio: encaminha para secretaria ──
    if (msgs.includes('__AUDIO__') || txtCompleto === '__AUDIO__') {
      if (await emAtendimentoHumano(num)) { processarFila(num); return; }
      await ativarHumano(num, 5);
      await enviar(num,
        'Olá! 😊 Recebemos seu áudio.\n\n' +
        'No momento nossa assistente virtual não consegue processar mensagens de voz. ' +
        'Por isso estou encaminhando você para nossa *secretaria*, que irá te atender em breve! 🏥\n\n' +
        'Se preferir, pode digitar sua mensagem que respondemos na hora. 😊\n\n' +
        '🔹 *Transferindo para a secretaria do Centro Médico America...*'
      );
      console.log('AUDIO [' + num + ']: transferido para secretaria');
      processarFila(num);
      return;
    }

    if (txtCompleto.toLowerCase() === '#humano' || txtCompleto.toLowerCase() === '#secretaria') {
      await ativarHumano(num, 5);
      await enviar(num, 'Obrigado por entrar em contato com o *Centro Médico America*.\n\nSua solicitação requer um acompanhamento especializado da nossa equipe. Para oferecer a você a melhor experiência possível, vou encaminhar sua conversa para um de nossos consultores.\n\nTodas as informações registradas durante este atendimento serão compartilhadas internamente, garantindo continuidade e agilidade no suporte, sem necessidade de repetir os dados já fornecidos.\n\nNossa equipe assumirá seu atendimento em instantes para concluir sua solicitação com total atenção e cuidado.\n\nAgradecemos pela preferência e pela confiança em nossos serviços.\n\n🔹 *Transferindo para um especialista do Centro Médico America...*');
      processarFila(num);
      return;
    }

    if (txtCompleto === '#cma') {
      await desativarHumano(num);
      processarFila(num);
      return;
    }

    if (await emAtendimentoHumano(num)) { processarFila(num); return; }

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

  const b = req.body;

  // Log geral (inclui áudio)
  webhookLogs.unshift({
    time: new Date().toISOString(),
    phone: b.phone,
    type: b.messageType || b.type || 'text',
    text: b.text && b.text.message
  });
  if (webhookLogs.length > 30) webhookLogs.pop();

  if (b.type !== 'ReceivedCallback') return;
  if (b.isGroup) return;
  const num = b.phone || '';
  if (!num || num.includes('@lid') || num.includes('-group')) return;
  if (NUMEROS_IGNORAR.includes(num)) return;
  if (b.fromMe || b.fromApi) return;

  // ── Detecta áudio antes de checar texto ──
  if (detectarAudio(b)) {
    console.log('AUDIO recebido de [' + num + '] — encaminhando para secretaria');
    enfileirarAudio(num);
    return;
  }

  const txt = (b.text && b.text.message) || '';
  if (!txt.trim()) return;

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

// ── API Dashboard ──
app.get('/api/dashboard', async function(req, res) {
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const ini  = hoje + 'T00:00:00';
    const fim  = hoje + 'T23:59:59';
    const [agHoje, totalMsgs, totalPac, agReceita, ultimasMsgs] = await Promise.all([
      db.supabase.from('agendamentos').select('*').gte('data_agendamento', ini).lte('data_agendamento', fim),
      db.supabase.from('mensagens_whatsapp').select('*', { count: 'exact', head: true }).gte('created_at', ini),
      db.supabase.from('pacientes').select('*', { count: 'exact', head: true }),
      db.supabase.from('agendamentos').select('valor').gte('data_agendamento', ini).lte('data_agendamento', fim).eq('status', 'confirmado'),
      db.supabase.from('mensagens_whatsapp').select('*').order('created_at', { ascending: false }).limit(5),
    ]);
    const receitaHoje = (agReceita.data || []).reduce(function(s, r) { return s + (r.valor || 0); }, 0);
    res.json({
      consultasHoje:   (agHoje.data || []).length,
      msgsHoje:         totalMsgs.count || 0,
      totalPacientes:   totalPac.count  || 0,
      receitaHoje,
      agendamentosHoje: agHoje.data     || [],
      ultimasMensagens: ultimasMsgs.data|| [],
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/whatsapp', async function(req, res) {
  try {
    const r = await db.supabase.from('mensagens_whatsapp').select('*').order('created_at', { ascending: false }).limit(100);
    res.json(r.data || []);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/', function(req, res) { res.json({ status: 'online', agente: 'CMA v2', uptime: Math.floor(process.uptime()) + 's' }); });
app.listen(PORT, function() { console.log('CMA Assistente Premium v2 | Porta: ' + PORT + ' | Online'); });
