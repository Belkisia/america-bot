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
  '556284271335',  // Dr. Wilder (proprietário)
  '5562982797221', // médico
  '5562998079861', // médico
  '5562981604381', // médico
  '5562981764258', // médico
  '5562993598081', // médico
  '5562981958856', // médico
];

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

const SYSTEM_PROMPT = `Você se chama América, assistente do Centro Médico América, Goiânia-GO. Elegante, profissional, calorosa. Jamais dá diagnósticos. NUNCA negue serviço que a clínica oferece — transfira para secretaria se não souber detalhes.

REGRA CRÍTICA: Leia TODO o histórico. NUNCA reinicie conversa. NUNCA peça dado já fornecido.

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
• Ginecologia: 08/06, 22/06, 29/06 das 13h00–17h30 — SOMENTE TARDE
• Clínico Geral/Pediatria: 09/06 08h–11h45 | 11/06 08h–11h45 e 13h30–17h30

PERÍODO: Para Clínico Geral/Pediatria pergunte o dia e informe horários. Para demais, use o período fixo da agenda sem perguntar.

ULTRASSOM
Não é especialidade — é exame. Colete: nome, nascimento, qual exame.
Tag: [AGENDAR:nome=X|nascimento=X|especialidade=Ultrassom|convenio=particular|periodo=manha]

TERÇA 07h30–11h30: Transvaginal, Obstétrica, Obstétrica Endovaginal, Morfológica 2ºTri, Abdome Total/Superior/Inferior, Pélvica, Mamas, Axilas, Próstata Abdominal, Tireoide.
SEXTA 07h30–09h30 e 17h–18h: TODOS os exames.
SOMENTE SEXTA: Morfológica 1º/3ºTri, Doppler qualquer tipo, Articulação, Bolsa Escrotal, Transfontanela, Quadril, Punho, Pé, Orelha, Cervical, Ombro, Inguinal, Parótidas, Partes Moles, Parede Abdominal, Gestação Múltipla, Vias Urinárias, Abdome c/Doppler.

MORFOLÓGICO: 1ºTri=11–13sem6d(R$230) | 2ºTri=20–23sem6d(R$280) | 3ºTri=32–34sem6d.

PREÇOS ULTRASSOM (informe só quando perguntado): Abdome Inf R$70|c/Dop R$160 | Abdome Sup R$70|c/Dop R$160 | Abdome Total R$100|c/Dop R$350 | Articulação R$80 | Bolsa Escrotal R$80|c/Dop R$150 | Mamas R$90 | Morfológica 1ºTri R$230|2ºTri R$280 | Obstétrica>14sem R$100|c/Dop R$280|Endovaginal R$100|Múltipla R$180 | Partes Moles R$70 | Próstata R$90 | Quadril Ped R$80 | Tireoide R$90|c/Dop R$150 | Transvaginal R$90|c/Dop R$160 | Vias Urinárias R$80 | Transfontanela R$130 | Pélvica R$80 | Punho R$80 | Parede Abd R$80 | Parótidas R$70|c/Dop R$160 | Pé R$80 | Quadril Ad R$80 | Orelha R$70 | Cervical R$80 | Ombro R$90 | Inguinal R$80 | Doppler Isolado R$140 | Doppler Carótidas R$150.

CONSULTAS: Clínico Geral R$80 | Ginecologia R$120 | Endocrinologia R$120 | Psiquiatria R$120 | Pediatria R$100 | Otorrino R$140.
PROCEDIMENTOS: Limpeza ouvido R$50 | DIU inserir R$400 | DIU retirar R$300 | Prevenção R$80 | Retirada pontos R$50.

EXAMES LABORATORIAIS
A clínica FAZ exames laboratoriais (sangue, urina, Beta-HCG gravidez, hemograma, etc). NUNCA negar.
Para orçamento: peça lista ou foto dos exames antes de transferir. Depois use [SECRETARIA].

TRANSFERÊNCIA PARA SECRETARIA
Quando transferir: explique brevemente ao paciente e adicione [SECRETARIA] no final. NÃO escreva "transferindo", NÃO coloque telefones. Contatos só quando paciente pedir ou na confirmação.
Contatos: 📞 (62) 3636-3536 | 📱 (62) 99504-9138

REGRAS FINAIS
- UMA única mensagem por resposta.
- Nome+nascimento: pergunte juntos, extraia juntos do histórico.
- Ao confirmar agendamento: *Seu atendimento foi solicitado com sucesso!* ✅ + endereço + aviso que equipe confirmará horário.
- Endereço: Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia-GO, CEP 74485-055.
- Sem markdown #. Máximo 3 parágrafos curtos.`;

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
      if (hist.length > 0 && hist[hist.length - 1].role === m.role) {
        hist[hist.length - 1].content += ' ' + content;
      } else {
        hist.push({ role: m.role, content: content });
      }
    }
    while (hist.length > 0 && hist[0].role !== 'user') hist.shift();
    while (hist.length > 0 && hist[hist.length - 1].role !== 'user') hist.pop();
    if (hist.length === 0) throw new Error('Histórico vazio após validação');

    const now = new Date();
    const agora = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const diaSemana = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' });
    const dataHoje = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora = parseInt(now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
    const saudacao = hora >= 5 && hora < 12 ? 'Bom dia' : hora >= 12 && hora < 18 ? 'Boa tarde' : 'Boa noite';
    const despedida = hora >= 18 || hora < 5 ? 'Tenha uma boa noite' : hora < 12 ? 'Tenha um ótimo dia' : 'Tenha uma boa tarde';

    const systemComData = SYSTEM_PROMPT
      + '\n\nDATA E HORA ATUAL (Brasília): ' + agora
      + '\nHoje é ' + diaSemana + ', ' + dataHoje + '.'
      + '\nSAUDAÇÃO CORRETA AGORA: "' + saudacao + '" — use esta saudação em todas as mensagens iniciais.'
      + '\nDESPEDIDA CORRETA AGORA: "' + despedida + '" — use ao encerrar atendimento. NUNCA use saudação errada para o período do dia.';

    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 600, system: systemComData, messages: hist },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 35000 }
    );
    return r.data.content[0].text;
  } catch(e) {
    if (tentativa < 2 && e.message !== 'Histórico vazio após validação') {
      console.log('RETRY IA tentativa ' + (tentativa + 1));
      await new Promise(function(r) { setTimeout(r, 3000); });
      return chamarIA(msgs, tentativa + 1);
    }
    throw e;
  }
}

// Controle de concorrência — máximo 3 conversas simultâneas
let conversasAtivas = 0;
const MAX_SIMULTANEAS = 3;

async function enviar(numero, texto) {
  try {
    // Simula digitação: 1 segundo por cada 100 chars, mínimo 3s, máximo 8s
    const tempoDigitacao = Math.min(Math.max(Math.floor(texto.length / 100) * 1000, 3000), 8000);
    // Adiciona variação aleatória para parecer mais humano
    const variacao = Math.floor(Math.random() * 2000);
    await new Promise(function(r) { setTimeout(r, tempoDigitacao + variacao); });

    await axios.post(EVOLUTION_API_URL, { phone: numero, message: texto },
      { headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN }, timeout: 10000 }
    );
    console.log('ENVIADO [' + numero + ']: ' + texto.slice(0, 50) + '...');
  } catch(e) { console.error('Erro enviar:', e.message); }
}

// ── Lê imagem/receituário via Claude Vision ──
async function lerImagem(imageUrl) {
  try {
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const contentType = imgResp.headers['content-type'] || 'image/jpeg';
    const base64 = Buffer.from(imgResp.data).toString('base64');
    const mediaType = contentType.split(';')[0].trim();

    const r = await axios.post('https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 }
            },
            {
              type: 'text',
              text: `Você é um assistente de clínica médica. Analise esta imagem e identifique:
1. Se é uma receita/pedido médico: extraia o nome do médico, CRM (se visível) e os exames ou procedimentos solicitados.
2. Se é um exame/resultado: identifique o tipo de exame.
3. Se é outra coisa: descreva brevemente o que é.

Responda em formato simples, direto, sem markdown. Foque apenas nos exames/procedimentos solicitados que possam ser realizados numa clínica médica (ultrassom, consultas, procedimentos). Não mencione medicamentos.`
            }
          ]
        }]
      },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 30000 }
    );
    return r.data.content[0].text;
  } catch(e) {
    console.error('Erro lerImagem:', e.message);
    return null;
  }
}
function detectarAudio(b) {
  if (b.audio) return true;
  if (b.messageType === 'audioMessage') return true;
  if (b.messageType === 'pttMessage') return true;
  if (b.type === 'audio') return true;
  if (b.type === 'ptt') return true;
  return false;
}

// ── Detecta PDF especificamente ──
function detectarPDF(b) {
  if (b.document && b.document.mimeType && b.document.mimeType.includes('pdf')) return true;
  if (b.document && b.document.fileName && b.document.fileName.toLowerCase().endsWith('.pdf')) return true;
  if (b.messageType === 'documentMessage' && JSON.stringify(b).toLowerCase().includes('pdf')) return true;
  return false;
}

// ── Detecta imagem, documento, receituário ──
function detectarImagem(b) {
  if (detectarPDF(b)) return false; // PDF tem tratamento separado
  if (b.image) return true;
  if (b.document) return true;
  if (b.messageType === 'imageMessage') return true;
  if (b.messageType === 'documentMessage') return true;
  const txt = (b.text && b.text.message) || '';
  if (!txt.trim() && !detectarAudio(b)) return true;
  return false;
}

// Follow-up desativado
function agendarFollowUp(num) { /* desativado */ }
function cancelarFollowUp(num) {
  if (followUpTimers && followUpTimers[num]) {
    clearTimeout(followUpTimers[num]);
    delete followUpTimers[num];
  }
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

// Enfileira imagem/documento com URL
function enfileirarImagem(num, imageUrl) {
  if (!filas[num]) filas[num] = { msgs: [], rodando: false };
  filas[num].msgs.push('__IMAGEM__:' + (imageUrl || ''));
  if (!filas[num].rodando) processarFila(num);
}

// Enfileira PDF
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

  // Limite de conversas simultâneas — espera com retry até ter vaga
  let tentativas = 0;
  while (conversasAtivas >= MAX_SIMULTANEAS && tentativas < 10) {
    tentativas++;
    await new Promise(function(r) { setTimeout(r, 3000); });
  }

  filas[num].rodando = true;
  conversasAtivas++;
  console.log('PROC_START [' + num + '] ativas=' + conversasAtivas);

  // Aguarda 4s para agrupar mensagens fragmentadas
  await new Promise(function(r) { setTimeout(r, 4000); });

  // Segurança: limpa fila se cresceu demais (evita acúmulo)
  if (filas[num].msgs.length > 10) {
    console.log('FILA LIMPA [' + num + ']: ' + filas[num].msgs.length + ' msgs acumuladas');
    filas[num].msgs = filas[num].msgs.slice(-3);
  }

  const msgs = filas[num].msgs.splice(0);
  const txtCompleto = msgs.join(' ').trim();

  try {
    console.log('PROC [' + num + ']:', txtCompleto);

    // ── Tratamento de PDF ──
    if (msgs.includes('__PDF__') || txtCompleto === '__PDF__') {
      if (await emAtendimentoHumano(num)) { processarFila(num); return; }
      await ativarHumano(num, 60);
      await enviar(num,
        'Olá! 😊 Recebi seu arquivo PDF.\n\n' +
        'O envio de documentos em PDF é feito diretamente pela nossa secretaria. ' +
        'Vou transferir seu atendimento agora para que nossa equipe possa te ajudar com isso! 📋\n\n' +
        '🔹 *Nossa secretaria assumirá seu atendimento em instantes!*'
      );
      cancelarFollowUp(num);
      console.log('PDF [' + num + ']: transferido para secretaria');
      processarFila(num);
      return;
    }

    // ── Tratamento de áudio: encaminha para secretaria ──
    if (msgs.includes('__AUDIO__') || txtCompleto === '__AUDIO__') {
      if (await emAtendimentoHumano(num)) { processarFila(num); return; }
      await ativarHumano(num, 15);
      await enviar(num,
        'Olá! 😊 Recebemos seu áudio.\n\n' +
        'No momento nossa assistente virtual não consegue processar mensagens de voz. ' +
        'Por isso estou encaminhando você para nossa *secretaria*, que irá te atender em breve! 🏥\n\n' +
        'Se preferir, pode digitar sua mensagem que respondemos na hora. 😊\n\n' +
        '🔹 *Transferindo para a secretaria do Centro Médico América...*'
      );
      console.log('AUDIO [' + num + ']: transferido para secretaria');
      processarFila(num);
      return;
    }

    // ── Tratamento de imagem/documento: receituário, exame, foto ──
    const imagemMsg = msgs.find(m => m && m.startsWith('__IMAGEM__'));
    if (imagemMsg) {
      if (await emAtendimentoHumano(num)) { processarFila(num); return; }
      const imageUrl = imagemMsg.replace('__IMAGEM__:', '').trim();
      console.log('IMAGEM [' + num + ']: processando com visão — ' + imageUrl);

      // Tenta ler a imagem com Claude Vision
      let leitura = null;
      if (imageUrl) leitura = await lerImagem(imageUrl);

      if (leitura) {
        // Monta contexto para a América responder com base na leitura
        const msgContexto = 'O paciente enviou uma imagem/receita. Análise da imagem: ' + leitura + '\n\nCom base nisso, responda ao paciente em UMA ÚNICA mensagem curta e calorosa: confirme o que foi identificado (nome do paciente e exames), informe que realizamos esses exames aqui no Centro Médico América e que nossa secretaria entrará em contato para confirmar disponibilidade e valores. Finalize com os contatos: 📞 (62) 3636-3536 | 📱 (62) 99504-9138. NÃO use tags [SECRETARIA], NÃO repita mensagem de transferência, NÃO diga "transferindo". Apenas responda diretamente ao paciente.';
        await db.salvarMensagem(num, 'user', '[imagem enviada pelo paciente]');
        let hist = await db.buscarHistorico(num, 20);
        hist.push({ role: 'user', content: msgContexto });
        const resp = await chamarIA(hist);
        const final = limpar(resp).replace('[SECRETARIA]', '').replace(/🔹.*Transferindo.*$/gm, '').trim();
        await db.salvarMensagem(num, 'assistant', final);
        await enviar(num, final);
        // Se tiver exames laboratoriais na leitura, ativa secretaria silenciosamente
        if (leitura.toLowerCase().includes('laboratori') || leitura.toLowerCase().includes('sangue') || leitura.toLowerCase().includes('urina') || leitura.toLowerCase().includes('exame')) {
          await ativarHumano(num, 15);
        }
        console.log('IMAGEM [' + num + ']: respondido com visão');
      } else {
        // Fallback: sem URL ou erro na leitura — transfere para secretaria
        await ativarHumano(num, 15);
        await enviar(num,
          'Olá! 😊 Recebemos seu documento.\n\n' +
          'Vou encaminhar para nossa *secretaria*, que irá analisar e te orientar sobre os próximos passos com todos os detalhes! 🏥\n\n' +
          '📞 Telefone: (62) 3636-3536\n' +
          '📱 WhatsApp: (62) 99504-9138\n\n' +
          '🔹 *Transferindo para a secretaria do Centro Médico América...*'
        );
        console.log('IMAGEM [' + num + ']: sem URL — transferido para secretaria');
      }
      processarFila(num);
      return;
    }

    if (txtCompleto.toLowerCase() === '#humano' || txtCompleto.toLowerCase() === '#secretaria') {
      await ativarHumano(num, 60);
      cancelarFollowUp(num);
      await enviar(num, 'Obrigado por entrar em contato com o *Centro Médico América*.\n\nSua solicitação requer um acompanhamento especializado da nossa equipe. Para oferecer a você a melhor experiência possível, vou encaminhar sua conversa para um de nossos consultores.\n\nTodas as informações registradas durante este atendimento serão compartilhadas internamente, garantindo continuidade e agilidade no suporte, sem necessidade de repetir os dados já fornecidos.\n\nNossa equipe assumirá seu atendimento em instantes para concluir sua solicitação com total atenção e cuidado.\n\nAgradecemos pela preferência e pela confiança em nossos serviços.\n\n🔹 *Transferindo para um especialista do Centro Médico América...*');
      processarFila(num);
      return;
    }

    if (txtCompleto === '#cma') {
      await desativarHumano(num);
      console.log('CMA reativada para [' + num + ']');
      processarFila(num);
      return;
    }

    if (await emAtendimentoHumano(num)) { processarFila(num); return; }

    await db.salvarMensagem(num, 'user', txtCompleto);
    let hist = await db.buscarHistorico(num, 20);
    if (hist.length === 0 || hist[hist.length - 1].role !== 'user') {
      hist.push({ role: 'user', content: txtCompleto });
    }

    const resp = await chamarIA(hist);
    const ag = extrairAgendamento(resp);
    if (ag) {
      // Verifica duplicata — mesmo telefone + especialidade nas últimas 24h
      const ontemISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: jaExiste } = await db.supabase
        .from('agendamentos')
        .select('id')
        .eq('telefone', num)
        .eq('especialidade', ag.especialidade)
        .gte('created_at', ontemISO)
        .limit(1);

      if (jaExiste && jaExiste.length > 0) {
        console.log('DUPLICATA IGNORADA [' + num + ']:', ag.especialidade);
      } else {
        await db.salvarAgendamento({ nome_paciente: ag.nome, data_nascimento: ag.nascimento || null, telefone: num, especialidade: ag.especialidade, convenio: 'particular', periodo: ag.periodo, origem: 'whatsapp' });
        console.log('AGENDADO:', ag.nome, ag.especialidade);
      }
    }

    // Detecta se a IA pediu transferência para secretaria
    const pedirSecretaria = resp.includes('[SECRETARIA]');
    const final = limpar(resp)
      .replace('[SECRETARIA]', '')
      .replace(/claro!?\s*para informações detalhadas sobre isso.*?instantes\.?/gis, '')
      .replace(/📞\s*Telefone:.*?[\n\r]/gi, '')
      .replace(/📱\s*WhatsApp:.*?[\n\r]/gi, '')
      .replace(/🔹.*?transferindo.*?[\n\r]?/gi, '')
      .replace(/nossa equipe assumirá.*?instantes\.?/gi, '')
      .trim();
    await db.salvarMensagem(num, 'assistant', final);
    await enviar(num, final);

    if (pedirSecretaria) {
      await ativarHumano(num, 60);
      cancelarFollowUp(num);
      await enviar(num, '🔹 *Nossa secretaria já recebeu seu atendimento e entrará em contato em instantes!*');
      console.log('SECRETARIA [' + num + ']: transferência ativada pela América');
    } else {
      // Agenda follow-up: se paciente não responder em 10min, América manda uma mensagem
      agendarFollowUp(num);
    }

    console.log('OK [' + num + ']');
  } catch(e) {
    console.error('ERRO [' + num + ']:', e.message);
  }

  conversasAtivas = Math.max(0, conversasAtivas - 1);
  processarFila(num);
}

// Webhook
const webhookLogs = [];
app.get('/webhook', function(req, res) { res.sendStatus(200); });
app.post('/webhook', function(req, res) {
  res.sendStatus(200);

  const b = req.body;

  // Log completo para diagnóstico (primeiros 5 campos + body completo)
  webhookLogs.unshift({
    time: new Date().toISOString(),
    phone: b.phone,
    type: b.messageType || b.type || 'text',
    text: b.text && b.text.message,
    imageUrl: b.image && b.image.imageUrl,
    body: JSON.stringify(b).slice(0, 1200)
  });
  if (webhookLogs.length > 30) webhookLogs.pop();

  if (b.type !== 'ReceivedCallback') return;
  if (b.isGroup) return;
  const num = b.phone || '';
  if (!num || num.includes('@lid') || num.includes('-group')) return;
  if (NUMEROS_IGNORAR.includes(num)) return;

  // ── Secretaria humana digitou: pausa a CMA automaticamente por 15 min ──
  // fromMe = true significa que a mensagem foi enviada PELO WhatsApp Business (secretaria)
  // fromApi = true significa que foi enviada pela API (próprio bot) — ignorar
  if (b.fromMe && !b.fromApi) {
    const txtSecretaria = (b.text && b.text.message) || '';
    // Ignora se for o comando #cma (reativação manual)
    if (txtSecretaria.trim() !== '#cma') {
      cancelarFollowUp(num);
      ativarHumano(num, 60).then(function() {
        console.log('SECRETARIA [' + num + ']: atendimento humano ativado por 60min — CMA pausada');
      });
    }
    return;
  }

  if (b.fromApi) return;

  // ── Detecta áudio antes de checar texto ──
  if (detectarAudio(b)) {
    console.log('AUDIO recebido de [' + num + '] — encaminhando para secretaria');
    enfileirarAudio(num);
    return;
  }

  // ── Detecta PDF ──
  if (detectarPDF(b)) {
    console.log('PDF recebido de [' + num + ']');
    enfileirarPDF(num);
    return;
  }

  // ── Detecta imagem, documento, receituário ──
  if (detectarImagem(b)) {
    const imageUrl = (b.image && b.image.imageUrl) || (b.document && b.document.documentUrl) || '';
    console.log('IMAGEM recebida de [' + num + '] url=' + imageUrl.slice(0, 80) + '...');
    console.log('IMAGEM url completa length=' + imageUrl.length);
    enfileirarImagem(num, imageUrl);
    return;
  }

  const txt = (b.text && b.text.message) || '';
  if (!txt.trim()) return;

  cancelarFollowUp(num);
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
    let hist = await db.buscarHistorico(tel, 20);
    if (hist.length === 0 || hist[hist.length-1].role !== 'user') hist.push({ role: 'user', content: msg });
    const resp = await chamarIA(hist);
    const ag = extrairAgendamento(resp);
    if (ag) await db.salvarAgendamento({ nome_paciente: ag.nome, data_nascimento: ag.nascimento || null, telefone: tel, especialidade: ag.especialidade, convenio: 'particular', periodo: ag.periodo, origem: 'chat' });
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

// ── Integração Quark Clinic ──
const QUARK_HEADERS = {
  'Content-Type': 'application/json',
  'Auth-token': 'bgdWIDWVoYDQBtFLLlblOQpDoalqBbWXJbezRxVhbujmivbakllRWcAoHcxMHqbk',
  'X-Chave-Key': '5196e91382b959a96f18aa61485c30de2a6b9f42241d4b0d5b3fe5426758dc95',
  'X-Secret-Key': 'f7c217f2aeeef1ea6fc2db2aa22a028dee1246989e52c21866515b2de25bbecb'
};
const QUARK_BASE = 'https://api.quark.tec.br/clinic/ext';

async function quarkCriarPaciente(dados) {
  try {
    const r = await axios.post(QUARK_BASE + '/paciente', dados, { headers: QUARK_HEADERS, timeout: 10000 });
    return r.data;
  } catch(e) {
    console.error('QUARK paciente:', e.response ? JSON.stringify(e.response.data) : e.message);
    return null;
  }
}

async function quarkCriarAgendamento(dados) {
  try {
    const r = await axios.post(QUARK_BASE + '/agendamento', dados, { headers: QUARK_HEADERS, timeout: 10000 });
    return r.data;
  } catch(e) {
    console.error('QUARK agendamento:', e.response ? JSON.stringify(e.response.data) : e.message);
    return null;
  }
}

// Endpoint de teste da API Quark — acesse /test-quark para verificar conexão
app.get('/test-quark', async function(req, res) {
  try {
    const testes = {};
    const endpoints = [
      'v1/paciente', 'v1/pacientes', 'v1/agendamento', 'v1/agendamentos',
      'v2/paciente', 'v2/pacientes', 'v2/agendamento', 'v2/agendamentos',
      'api/paciente', 'api/pacientes', 'api/agendamento',
      'paciente/listar', 'agendamento/listar', 'agenda/listar',
      'clinica', 'clinica/paciente', 'clinica/agendamento',
      'externo/paciente', 'externo/agendamento',
      'public/paciente', 'public/agendamento',
    ];
    for (const ep of endpoints) {
      try {
        const r = await axios.get(QUARK_BASE + '/' + ep, { headers: QUARK_HEADERS, timeout: 6000 });
        testes[ep] = { status: r.status, data: JSON.stringify(r.data).slice(0, 300) };
      } catch(e) {
        testes[ep] = { status: e.response ? e.response.status : 'ERR', msg: e.response ? JSON.stringify(e.response.data).slice(0, 150) : e.message };
      }
    }
    res.json({ quark: 'teste', base: QUARK_BASE, resultados: testes });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/', function(req, res) { res.json({ status: 'online', agente: 'CMA v2', uptime: Math.floor(process.uptime()) + 's' }); });
app.listen(PORT, function() { console.log('América — Assistente CMA v2 | Porta: ' + PORT + ' | Online'); });
