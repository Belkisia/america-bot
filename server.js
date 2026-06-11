const express = require('express');
const axios = require('axios');
const db = require('./supabase');
const app = express();
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const PORT = process.env.PORT || 3000;
const NUMEROS_IGNORAR = [
  '556284271335',
  '5562982797221',
  '5562998079861',
  '5562981604381',
  '5562981764258',
  '5562993598081',
  '5562981958856',
];

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

const SYSTEM_PROMPT = `Você se chama América, assistente do Centro Médico América, Goiânia-GO. Elegante, profissional, calorosa. Jamais dá diagnósticos. NUNCA negue serviço que a clínica oferece.

REGRA CRÍTICA: Leia TODO o histórico antes de responder. NUNCA reinicie conversa. NUNCA peça dado já fornecido. NUNCA liste especialidades se o paciente já informou qual quer.

MEMÓRIA: Antes de cada resposta identifique o que já foi fornecido: especialidade, nome, nascimento, data/período. Se já apareceu no histórico, não pergunte de novo.

AGENDAMENTO DE CONSULTAS
Especialidades: Clínico Geral, Endocrinologia, Ginecologia, Otorrinolaringologia, Pediatria, Psiquiatria.
Colete: nome completo + data de nascimento (na mesma pergunta), especialidade, período.
Tag: [AGENDAR:nome=X|nascimento=X|especialidade=X|convenio=particular|periodo=X]
Somente particular. NUNCA pergunte convênio.
ANTI-DUPLICATA: Se histórico já tem confirmação da mesma especialidade, NÃO gere [AGENDAR] de novo.

AGENDA MÉDICOS
• Psiquiatria: 24/06 das 13h30–17h30 — SOMENTE TARDE
• Endocrinologia: 16/06 e 30/06 das 14h00–17h30 — SOMENTE TARDE
• Otorrinolaringologia: 16/06 e 30/06 das 08h00–11h30 — SOMENTE MANHÃ
• Ginecologia: 25/06 das 08h00–11h30 (manhã) | 29/06 das 13h00–17h30 (tarde)
• Clínico Geral/Pediatria: 11/06 08h–11h45 e 13h30–17h30

REGRA DE DATAS: Compare cada data com a DATA ATUAL do prompt. Mostre SOMENTE datas futuras. Se hoje é 10/06: Ginecologia tem 25/06 manhã e 29/06 tarde. Cada data tem horário diferente — informe corretamente. Se TODAS passaram: informe que não há agenda disponível no momento.

PERÍODO: Para Clínico Geral/Pediatria pergunte o dia e informe horários. Para demais use o período fixo sem perguntar.

ULTRASSOM
Não é especialidade — é exame. Colete: nome, nascimento, qual exame.
Tag: [AGENDAR:nome=X|nascimento=X|especialidade=Ultrassom|convenio=particular|periodo=manha]
TERÇA 07h30–11h30: Transvaginal, Obstétrica, Obstétrica Endovaginal, Morfológica 2ºTri, Abdome Total/Superior/Inferior, Pélvica, Mamas, Axilas, Próstata Abdominal, Tireoide.
SEXTA 07h30–09h30 e 17h–18h: TODOS os exames.
SOMENTE SEXTA: Morfológica 1º/3ºTri, Doppler qualquer tipo, Articulação, Bolsa Escrotal, Transfontanela, Quadril, Punho, Pé, Orelha, Cervical, Ombro, Inguinal, Parótidas, Partes Moles, Parede Abdominal, Gestação Múltipla, Vias Urinárias, Abdome c/Doppler.
MORFOLÓGICO: 1ºTri=11–13sem6d(R$230) | 2ºTri=20–23sem6d(R$280) | 3ºTri=32–34sem6d.

PREÇOS ULTRASSOM: Abdome Inf R$70|c/Dop R$160 | Abdome Sup R$70|c/Dop R$160 | Abdome Total R$100|c/Dop R$350 | Articulação R$80 | Bolsa Escrotal R$80|c/Dop R$150 | Mamas R$90 | Morfológica 1ºTri R$230|2ºTri R$280 | Obstétrica>14sem R$100|c/Dop R$280|Endovaginal R$100|Múltipla R$180 | Partes Moles R$70 | Próstata R$90 | Quadril Ped R$80 | Tireoide R$90|c/Dop R$150 | Transvaginal R$90|c/Dop R$160 | Vias Urinárias R$80 | Transfontanela R$130 | Pélvica R$80 | Punho R$80 | Parede Abd R$80 | Parótidas R$70|c/Dop R$160 | Pé R$80 | Quadril Ad R$80 | Orelha R$70 | Cervical R$80 | Ombro R$90 | Inguinal R$80 | Doppler Isolado R$140 | Doppler Carótidas R$150.

CONSULTAS: Clínico Geral R$80 | Ginecologia R$120 | Endocrinologia R$120 | Psiquiatria R$120 | Pediatria R$100 | Otorrino R$140.
PROCEDIMENTOS: Limpeza ouvido R$50 | DIU inserir R$400 | DIU retirar R$300 | Prevenção R$80 | Retirada pontos R$50.

EXAMES LABORATORIAIS: A clínica FAZ exames laboratoriais (sangue, urina, Beta-HCG, hemograma etc). NUNCA negar. Para orçamento: peça lista ou foto antes de transferir. Depois use [SECRETARIA].

TRANSFERÊNCIA: Quando transferir explique brevemente e adicione [SECRETARIA] no final. NÃO coloque telefones — só quando paciente pedir ou na confirmação do agendamento.
Contatos: 📞 (62) 3636-3536 | 📱 (62) 99504-9138

REGRAS FINAIS
- UMA única mensagem por resposta. Máximo 3 parágrafos. Sem markdown #.
- Nome+nascimento: pergunte juntos, extraia juntos.
- Ao confirmar: *Seu atendimento foi solicitado com sucesso!* ✅ + endereço + aviso que equipe confirmará.
- Endereço: Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia-GO, CEP 74485-055.`;

function extrairAgendamento(t) {
  const m = t.match(/\[AGENDAR:([^\]]+)\]/);
  if (!m) return null;
  const d = {};
  m[1].split('|').forEach(function(p) { const i = p.indexOf('='); if (i > 0) d[p.substring(0,i).trim()] = p.substring(i+1).trim(); });
  return Object.keys(d).length >= 3 ? d : null;
}
function limpar(t) { return t.replace(/\[AGENDAR:[^\]]+\]/g, '').trim(); }

async function chamarIA(msgs, tentativa) {
  tentativa = tentativa || 1;
  try {
    const hist = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m || !m.role || !m.content) continue;
      const content = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).trim();
      if (!content) continue;
      if (hist.length > 0 && hist[hist.length-1].role === m.role) {
        hist[hist.length-1].content += ' ' + content;
      } else {
        hist.push({ role: m.role, content: content });
      }
    }
    while (hist.length > 0 && hist[0].role !== 'user') hist.shift();
    while (hist.length > 0 && hist[hist.length-1].role !== 'user') hist.pop();
    if (hist.length === 0) throw new Error('Histórico vazio');

    const now = new Date();
    const agora = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const diaSemana = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' });
    const dataHoje = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora = parseInt(now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
    const saudacao = hora >= 5 && hora < 12 ? 'Bom dia' : hora >= 12 && hora < 18 ? 'Boa tarde' : 'Boa noite';
    const despedida = hora >= 18 || hora < 5 ? 'Tenha uma boa noite' : hora < 12 ? 'Tenha um ótimo dia' : 'Tenha uma boa tarde';

    const nowBR = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    nowBR.setHours(0, 0, 0, 0);
    function dataFutura(dia, mes) { return new Date(2026, mes-1, dia) >= nowBR; }
    const agendaFiltrada = [
      dataFutura(24,6) ? '• Psiquiatria: 24/06 das 13h30–17h30 — SOMENTE TARDE' : '• Psiquiatria: sem agenda disponível no momento',
      '• Endocrinologia: ' + ([dataFutura(16,6)?'16/06':null, dataFutura(30,6)?'30/06':null].filter(Boolean).join(' e ') || 'sem agenda') + (dataFutura(16,6)||dataFutura(30,6) ? ' das 14h00–17h30 — SOMENTE TARDE' : ' no momento'),
      '• Otorrinolaringologia: ' + ([dataFutura(16,6)?'16/06':null, dataFutura(30,6)?'30/06':null].filter(Boolean).join(' e ') || 'sem agenda') + (dataFutura(16,6)||dataFutura(30,6) ? ' das 08h00–11h30 — SOMENTE MANHÃ' : ' no momento'),
      '• Ginecologia: ' + (function() {
        const datas = [];
        if (dataFutura(25,6)) datas.push('25/06 das 08h00–11h30 (manhã)');
        if (dataFutura(29,6)) datas.push('29/06 das 13h00–17h30 (tarde)');
        return datas.length ? datas.join(' | ') : 'sem agenda no momento';
      })(),
      '• Clínico Geral/Pediatria:' + (dataFutura(11,6) ? ' 11/06 08h–11h45 e 13h30–17h30' : ' sem agenda disponível no momento'),
    ].join('\n');

    // Detecta especialidade no histórico para injetar lembrete
    const todasMsgs = hist.map(function(m){return m.content;}).join(' ').toLowerCase();
    const esp = todasMsgs.includes('psiquiatria') ? 'Psiquiatria' :
      todasMsgs.includes('ginecolog') ? 'Ginecologia' :
      todasMsgs.includes('endocrinolog') ? 'Endocrinologia' :
      todasMsgs.includes('otorrino') ? 'Otorrinolaringologia' :
      todasMsgs.includes('pediatr') ? 'Pediatria' :
      (todasMsgs.includes('clínico')||todasMsgs.includes('clinico')) ? 'Clínico Geral' :
      (todasMsgs.includes('ultrassom')||todasMsgs.includes('usg')) ? 'Ultrassom' : null;

    let systemFinal = SYSTEM_PROMPT
      + '\n\nAGENDA ATUAL (somente datas futuras):\n' + agendaFiltrada
      + '\n\nDATA/HORA (Brasília): ' + agora + ' — Hoje é ' + diaSemana + ', ' + dataHoje
      + '\nSAUDAÇÃO: "' + saudacao + '" | DESPEDIDA: "' + despedida + '"';

    if (esp) {
      systemFinal += '\n\nLEMBRETE CRÍTICO: O paciente JÁ informou que quer ' + esp + '. NÃO pergunte especialidade. Prossiga para o próximo dado necessário.';
    }

    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 600, system: systemFinal, messages: hist },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 30000 }
    );
    return r.data.content[0].text;
  } catch(e) {
    if (tentativa < 2) {
      await new Promise(function(r){setTimeout(r,2000);});
      return chamarIA(msgs, tentativa+1);
    }
    throw e;
  }
}

async function enviar(numero, texto) {
  try {
    await axios.post(EVOLUTION_API_URL, { phone: numero, message: texto },
      { headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN }, timeout: 10000 }
    );
    console.log('ENVIADO [' + numero + ']');
  } catch(e) { console.error('Erro enviar:', e.message); }
}

async function lerImagem(imageUrl) {
  try {
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const base64 = Buffer.from(imgResp.data).toString('base64');
    const mediaType = (imgResp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'Analise esta imagem. Se for receita/pedido médico: extraia médico, CRM e exames solicitados. Se for resultado: identifique o tipo. Responda simples e direto, sem markdown.' }
      ]}]},
      { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 30000 }
    );
    return r.data.content[0].text;
  } catch(e) { console.error('Erro lerImagem:', e.message); return null; }
}

function detectarAudio(b) {
  return !!(b.audio || b.messageType === 'audioMessage' || b.messageType === 'pttMessage' || b.type === 'audio' || b.type === 'ptt');
}
function detectarPDF(b) {
  return !!(b.document && (b.document.mimeType||'').includes('pdf')) ||
    !!(b.document && (b.document.fileName||'').toLowerCase().endsWith('.pdf'));
}
function detectarImagem(b) {
  if (detectarPDF(b)) return false;
  if (b.image || b.document || b.messageType === 'imageMessage' || b.messageType === 'documentMessage') return true;
  const txt = (b.text && b.text.message) || '';
  return !txt.trim() && !detectarAudio(b);
}

// Cache de histórico em memória — atualizado imediatamente, sem depender do banco
const historicoCache = {};
const CACHE_MAX = 20; // máximo de mensagens por número

function cacheAdicionarMensagem(num, role, content) {
  if (!historicoCache[num]) historicoCache[num] = [];
  historicoCache[num].push({ role: role, content: content });
  if (historicoCache[num].length > CACHE_MAX) historicoCache[num] = historicoCache[num].slice(-CACHE_MAX);
}

async function buscarHistoricoComCache(num) {
  // Busca do banco
  const dbHist = await db.buscarHistorico(num, 20);
  // Se tem cache em memória com mais mensagens recentes, usa ele
  const cache = historicoCache[num] || [];
  if (cache.length >= dbHist.length) return cache;
  return dbHist;
}

// Fila independente por número
const filas = {};
const msgProcessadas = new Set();

function enfileirar(num, txt) {
  if (!filas[num]) filas[num] = { msgs: [], rodando: false };
  filas[num].msgs.push(txt);
  if (!filas[num].rodando) processarFila(num);
}
function enfileirarAudio(num) {
  if (!filas[num]) filas[num] = { msgs: [], rodando: false };
  filas[num].msgs.push('__AUDIO__');
  if (!filas[num].rodando) processarFila(num);
}
function enfileirarImagem(num, url) {
  if (!filas[num]) filas[num] = { msgs: [], rodando: false };
  filas[num].msgs.push('__IMAGEM__:' + (url||''));
  if (!filas[num].rodando) processarFila(num);
}
function enfileirarPDF(num) {
  if (!filas[num]) filas[num] = { msgs: [], rodando: false };
  filas[num].msgs.push('__PDF__');
  if (!filas[num].rodando) processarFila(num);
}

async function processarFila(num) {
  if (!filas[num] || filas[num].msgs.length === 0) {
    if (filas[num]) filas[num].rodando = false;
    return;
  }
  filas[num].rodando = true;

  // Aguarda 2s para agrupar mensagens fragmentadas
  await new Promise(function(r) { setTimeout(r, 2000); });

  if (filas[num].msgs.length > 10) filas[num].msgs = filas[num].msgs.slice(-3);

  const msgs = filas[num].msgs.splice(0);
  const txtCompleto = msgs.join(' ').trim();

  try {
    console.log('PROC [' + num + ']:', txtCompleto.slice(0, 80));

    // PDF
    if (msgs.includes('__PDF__')) {
      if (await emAtendimentoHumano(num)) { filas[num].rodando = false; processarFila(num); return; }
      await ativarHumano(num, 60);
      await enviar(num, 'Olá! 😊 Recebi seu arquivo PDF.\n\nO envio de documentos PDF é feito pela nossa secretaria. Vou transferir seu atendimento agora! 📋\n\n🔹 *Nossa secretaria assumirá em instantes!*');
      filas[num].rodando = false; processarFila(num); return;
    }

    // Áudio
    if (msgs.includes('__AUDIO__')) {
      if (await emAtendimentoHumano(num)) { filas[num].rodando = false; processarFila(num); return; }
      await ativarHumano(num, 60);
      await enviar(num, 'Olá! 😊 Recebemos seu áudio.\n\nNo momento não consigo processar mensagens de voz. Estou encaminhando para nossa *secretaria*! 🏥\n\nSe preferir, pode digitar sua mensagem. 😊\n\n🔹 *Transferindo para a secretaria do Centro Médico América...*');
      filas[num].rodando = false; processarFila(num); return;
    }

    // Imagem
    const imagemMsg = msgs.find(function(m) { return m && m.startsWith('__IMAGEM__'); });
    if (imagemMsg) {
      if (await emAtendimentoHumano(num)) { filas[num].rodando = false; processarFila(num); return; }
      const imageUrl = imagemMsg.replace('__IMAGEM__:', '').trim();
      const leitura = imageUrl ? await lerImagem(imageUrl) : null;
      if (leitura) {
        await db.salvarMensagem(num, 'user', '[imagem enviada]');
        let hist = await db.buscarHistorico(num, 20);
        hist = hist.filter(function(m){return m.content && m.content.trim();});
        hist.push({ role: 'user', content: 'O paciente enviou uma imagem. Análise: ' + leitura + '\n\nResponda em UMA mensagem: confirme o que identificou, informe se realizamos esses exames e que a secretaria confirmará detalhes. Finalize com 📞 (62) 3636-3536 | 📱 (62) 99504-9138' });
        const resp = await chamarIA(hist);
        const final = limpar(resp).replace('[SECRETARIA]', '').trim();
        await db.salvarMensagem(num, 'assistant', final);
        await enviar(num, final);
        if (leitura.toLowerCase().match(/laboratori|sangue|urina|exame/)) await ativarHumano(num, 60);
      } else {
        await ativarHumano(num, 60);
        await enviar(num, 'Olá! 😊 Recebemos seu documento.\n\nVou encaminhar para nossa *secretaria* que te orientará! 🏥\n\n📞 (62) 3636-3536 | 📱 (62) 99504-9138\n\n🔹 *Transferindo para a secretaria...*');
      }
      filas[num].rodando = false; processarFila(num); return;
    }

    // Comandos
    if (txtCompleto.toLowerCase() === '#humano' || txtCompleto.toLowerCase() === '#secretaria') {
      await ativarHumano(num, 60);
      await enviar(num, 'Obrigado por entrar em contato com o *Centro Médico América*.\n\nVou encaminhar sua conversa para um de nossos consultores.\n\n🔹 *Transferindo para um especialista do Centro Médico América...*');
      filas[num].rodando = false; processarFila(num); return;
    }
    if (txtCompleto === '#cma') {
      await desativarHumano(num);
      delete historicoCache[num]; // limpa cache ao reativar
      console.log('CMA reativada [' + num + ']');
      filas[num].rodando = false; processarFila(num); return;
    }

    if (await emAtendimentoHumano(num)) { filas[num].rodando = false; processarFila(num); return; }
    if (!txtCompleto.trim()) { filas[num].rodando = false; processarFila(num); return; }

    await db.salvarMensagem(num, 'user', txtCompleto);
    cacheAdicionarMensagem(num, 'user', txtCompleto);
    let hist = await buscarHistoricoComCache(num);
    hist = hist.filter(function(m){return m.content && m.content.trim();});
    if (hist.length === 0 || hist[hist.length-1].role !== 'user') {
      hist.push({ role: 'user', content: txtCompleto });
    }
    console.log('HIST [' + num + ']: ' + hist.length + ' msgs');

    // Extrai dados do histórico — usa ÚLTIMAS mensagens para contexto atual
    // Pega apenas as últimas 8 mensagens para evitar contaminação de conversas antigas
    const histRecente = hist.slice(-8);
    const todasMsgs = histRecente.map(function(m){return m.content;}).join(' ').toLowerCase();
    const esp = todasMsgs.includes('psiquiatria') ? 'Psiquiatria' :
      todasMsgs.includes('ginecolog') ? 'Ginecologia' :
      todasMsgs.includes('endocrinolog') ? 'Endocrinologia' :
      todasMsgs.includes('otorrino') ? 'Otorrinolaringologia' :
      todasMsgs.includes('pediatr') ? 'Pediatria' :
      (todasMsgs.includes('clínico')||todasMsgs.includes('clinico')) ? 'Clínico Geral' :
      (todasMsgs.includes('ultrassom')||todasMsgs.includes('usg')) ? 'Ultrassom' : null;

    // Detecta nome e nascimento nas últimas mensagens do usuário
    const msgsUser = histRecente.filter(function(m){return m.role==='user';}).map(function(m){return m.content;}).join(' ');
    const nascMatch = msgsUser.match(/(\d{2}\/\d{2}\/\d{4})/);
    const nascimento = nascMatch ? nascMatch[1] : null;
    // Nome: tenta extrair da primeira msg com data
    let nomeDetectado = null;
    if (nascimento) {
      histRecente.filter(function(m){return m.role==='user';}).forEach(function(m){
        const r = m.content.match(/([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)+)\s+\d{2}\/\d{2}\/\d{4}/);
        if (r) nomeDetectado = r[1];
      });
    }

    // Detecta período/data escolhida
    const periodoTarde = todasMsgs.includes('tarde') || todasMsgs.includes('17h') || todasMsgs.includes('13h');
    const periodoManha = todasMsgs.includes('manhã') || todasMsgs.includes('manha') || todasMsgs.includes('08h') || todasMsgs.includes('11h');
    const periodo = periodoTarde ? 'tarde' : periodoManha ? 'manha' : null;

    // Se confirmou e tem todos os dados — injeta instrução direta
    const confirmou = txtCompleto.toLowerCase().match(/pode|sim|confirma|confirmar|agendar|ok|quero/);
    if (confirmou && esp && nomeDetectado && nascimento && periodo) {
      hist.push({ role: 'user', content: '[INSTRUÇÃO DO SISTEMA: Todos os dados foram coletados. Gere AGORA a tag de agendamento: [AGENDAR:nome=' + nomeDetectado + '|nascimento=' + nascimento + '|especialidade=' + esp + '|convenio=particular|periodo=' + periodo + '] e confirme o agendamento ao paciente com a mensagem de sucesso.]' });
      console.log('AUTO-AGENDAR [' + num + ']:', esp, nomeDetectado, nascimento, periodo);
    }

    const resp = await chamarIA(hist);
    const ag = extrairAgendamento(resp);
    if (ag) {
      const ontemISO = new Date(Date.now() - 24*60*60*1000).toISOString();
      const { data: jaExiste } = await db.supabase.from('agendamentos').select('id').eq('telefone', num).eq('especialidade', ag.especialidade).gte('created_at', ontemISO).limit(1);
      if (!jaExiste || jaExiste.length === 0) {
        await db.salvarAgendamento({ nome_paciente: ag.nome, data_nascimento: ag.nascimento||null, telefone: num, especialidade: ag.especialidade, convenio: 'particular', periodo: ag.periodo, origem: 'whatsapp' });
        console.log('AGENDADO:', ag.nome, ag.especialidade);
      }
    }

    const pedirSecretaria = resp.includes('[SECRETARIA]');
    const final = limpar(resp).replace('[SECRETARIA]','').replace(/🔹.*?transferindo.*?[\n\r]?/gi,'').trim();
    await db.salvarMensagem(num, 'assistant', final);
    cacheAdicionarMensagem(num, 'assistant', final);
    await enviar(num, final);

    if (pedirSecretaria) {
      await ativarHumano(num, 60);
      await enviar(num, '🔹 *Nossa secretaria já recebeu seu atendimento e entrará em contato em instantes!*');
    }
    console.log('OK [' + num + ']');
  } catch(e) {
    console.error('ERRO [' + num + ']:', e.message);
  }

  filas[num].rodando = false;
  processarFila(num);
}

// Webhook
const webhookLogs = [];
app.get('/webhook', function(req, res) { res.sendStatus(200); });
app.post('/webhook', function(req, res) {
  res.sendStatus(200);
  const b = req.body;
  webhookLogs.unshift({ time: new Date().toISOString(), phone: b.phone, type: b.messageType||b.type||'text', text: b.text && b.text.message, imageUrl: b.image && b.image.imageUrl });
  if (webhookLogs.length > 50) webhookLogs.pop();

  if (b.type !== 'ReceivedCallback') return;
  if (b.isGroup || b.isNewsletter) return;
  if (b.waitingMessage || b.isStatusReply) return;
  const num = b.phone || '';
  if (!num || num.includes('@lid') || num.includes('-group')) return;
  if (NUMEROS_IGNORAR.includes(num)) return;

  // Deduplica por messageId
  const msgId = b.messageId || '';
  if (msgId && msgProcessadas.has(msgId)) { console.log('DUP [' + msgId + ']'); return; }
  if (msgId) { msgProcessadas.add(msgId); setTimeout(function(){msgProcessadas.delete(msgId);}, 10*60*1000); }

  // Secretaria humana digitou
  if (b.fromMe && !b.fromApi) {
    const t = (b.text && b.text.message) || '';
    if (t.trim() !== '#cma') {
      ativarHumano(num, 60).then(function(){ console.log('SECRETARIA [' + num + ']: CMA pausada 60min'); });
    }
    return;
  }
  if (b.fromApi) return;

  if (detectarAudio(b)) { enfileirarAudio(num); return; }
  if (detectarPDF(b)) { enfileirarPDF(num); return; }
  if (detectarImagem(b)) {
    const url = (b.image && b.image.imageUrl) || (b.document && b.document.documentUrl) || '';
    enfileirarImagem(num, url); return;
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
  try { res.json(await db.buscarAgendamentos({ status: req.query.status, limite: parseInt(req.query.limite)||50 })); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.get('/api/pacientes', async function(req, res) {
  try { const r = await db.supabase.from('pacientes').select('*').order('created_at',{ascending:false}); res.json(r.data||[]); }
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
    let hist = await db.buscarHistorico(tel, 20);
    if (!hist.length || hist[hist.length-1].role !== 'user') hist.push({ role: 'user', content: msg });
    const resp = await chamarIA(hist);
    const ag = extrairAgendamento(resp);
    if (ag) await db.salvarAgendamento({ nome_paciente: ag.nome, data_nascimento: ag.nascimento||null, telefone: tel, especialidade: ag.especialidade, convenio: 'particular', periodo: ag.periodo, origem: 'chat' });
    const final = limpar(resp);
    await db.salvarMensagem(tel, 'assistant', final);
    res.json({ resposta: final, agendamento: ag||null });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/dashboard', async function(req, res) {
  try {
    const hoje = new Date().toISOString().slice(0,10);
    const [agHoje, totalMsgs, totalPac, agReceita, ultimasMsgs] = await Promise.all([
      db.supabase.from('agendamentos').select('*').gte('created_at', hoje+'T00:00:00').lte('created_at', hoje+'T23:59:59'),
      db.supabase.from('mensagens_whatsapp').select('*',{count:'exact',head:true}).gte('created_at', hoje+'T00:00:00'),
      db.supabase.from('pacientes').select('*',{count:'exact',head:true}),
      db.supabase.from('agendamentos').select('valor').gte('created_at', hoje+'T00:00:00').eq('status','confirmado'),
      db.supabase.from('mensagens_whatsapp').select('*').order('created_at',{ascending:false}).limit(5),
    ]);
    res.json({ consultasHoje:(agHoje.data||[]).length, msgsHoje:totalMsgs.count||0, totalPacientes:totalPac.count||0, receitaHoje:(agReceita.data||[]).reduce(function(s,r){return s+(r.valor||0);},0), agendamentosHoje:agHoje.data||[], ultimasMensagens:ultimasMsgs.data||[] });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/whatsapp', async function(req, res) {
  try { const r = await db.supabase.from('mensagens_whatsapp').select('*').order('created_at',{ascending:false}).limit(100); res.json(r.data||[]); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/test-db', async function(req, res) {
  try {
    const t = 'teste_'+Date.now();
    await db.salvarMensagem(t, 'user', 'teste');
    await new Promise(function(r){setTimeout(r,300);});
    const hist = await db.buscarHistorico(t, 5);
    await db.supabase.from('conversas').delete().eq('telefone', t);
    res.json({ ok: true, salvou: hist.length > 0 });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/', function(req, res) { res.json({ status: 'online', agente: 'CMA v3', uptime: Math.floor(process.uptime())+'s' }); });
app.listen(PORT, function() { console.log('América — CMA v3 | Porta: ' + PORT + ' | Online'); });
