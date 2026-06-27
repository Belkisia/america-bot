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
  '5562982797221',
  '5562998079861',
  '5562981604381',
  '5562981764258',
  '5562993598081',
  '5562981958856',
  '5562999609263',
  '556299609263',
  '5562991199066',
  '5562984463157',
];

const cacheHumano = {};

// MODO TESTE — só esses números recebem resposta da América
const NUMEROS_TESTE = [
  '556284227156',  // 984227156
  '556284271335',  // 984271335
];
const MODO_TESTE = true; // muda para false quando quiser liberar para todos
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
• Psiquiatria: 07/07 das 13h30–17h00 — SOMENTE TARDE
• Otorrinolaringologia: 30/06 das 08h00–11h30 — SOMENTE MANHÃ
• Endocrinologia: 30/06 das 13h00–17h30 — SOMENTE TARDE
• Ginecologia: 06/07 das 13h30–17h15 — SOMENTE TARDE
• Clínico Geral/Pediatria — agenda semanal:
  - Segunda: 08h00–10h45 e 16h00–17h15
  - Terça: 08h00–11h30
  - Quarta: 08h00–11h30
  - Quinta: 08h00–11h30 e 14h00–17h15
  - Sexta: 08h00–11h30

REGRA DE DATAS: Compare cada data com a DATA ATUAL do prompt. Mostre SOMENTE datas futuras. Cada data tem horário diferente — informe corretamente conforme a agenda acima. Se TODAS passaram: informe que não há agenda disponível no momento.

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

AGENDA DE COLETA LABORATORIAL — 07h00 às 09h45:
O laboratório funciona em semanas alternadas:
• Semana A (29/06, 13/07, 27/07...): Segunda, Quarta e Sexta
• Semana B (07/07, 21/07...): Terça e Quinta

Para saber qual semana é qual, use a DATA ATUAL do prompt:
- Semana iniciada em 29/06 = Semana A (seg/qua/sex)
- Semana iniciada em 07/07 = Semana B (ter/qui)
- Alterna a cada semana a partir daí

Quando paciente perguntar sobre coleta/exames laboratoriais, informe os dias disponíveis da semana atual e da próxima, sempre das 07h00 às 09h45.

EXAMES LABORATORIAIS: A clínica FAZ exames laboratoriais. NUNCA negar. Quando paciente perguntar preço de exame(s), calcule o total e informe APENAS o valor total com as opções de pagamento — não liste os valores individuais. Para orçamento de pedido médico com foto: peça a foto/lista, depois use [SECRETARIA].

REGRAS DE PREÇO ESPECIAL:
- Hemograma SOZINHO: R$30
- Glicemia/Glicose SOZINHO: R$25
- Hemograma + Glicemia/Glicose SOMENTE OS DOIS (sem nenhum outro exame): R$55
- Hemoglobina glicada (HbA1c) SOZINHO: R$32
- Se hemograma ou glicemia vierem junto com OUTROS exames: use valores da tabela (hemograma R$20, glicemia R$15)
- COMBO LIPÍDICO: quando o pedido incluir Colesterol + LDL + HDL + VLDL + Triglicerídeos junto com OUTROS exames adicionais → cobrar esse conjunto como Lipidograma R$38 (não somar individualmente)
- Se o pedido for SOMENTE Colesterol + LDL + HDL + VLDL + Triglicerídeos (sem outros exames) → somar individualmente (R$12+R$14+R$14+R$14+R$14 = R$68) e mostrar só o total final
- NUNCA liste os valores individuais — informe APENAS os valores finais de pagamento
- NUNCA informe o valor base/total dos exames
- NUNCA explique como calculou os preços ou mencione regras internas de precificação
- As regras de cartão (+5%) e pix (-5%) se aplicam SOMENTE a exames laboratoriais
- Para ultrassom, consultas e procedimentos: informe o preço fixo diretamente, SEM aplicar percentuais, SEM mencionar desconto ou acréscimo
- Para exames laboratoriais: calcule internamente cartão = total × 1.05 | pix = total × 0.95 — mostre apenas os dois valores finais SEM mencionar percentuais
- Acima de R$299 no cartão: parcela em até 3x (mencione isso)
- Seja calorosa, humanizada e faça uma chamada para agendamento ao final, como neste exemplo:
"Olá! 😊 Segue o orçamento para os exames solicitados:
💳 Cartão de crédito: R$XX,XX
💵 Pix ou dinheiro: R$XX,XX
Que tal já garantir sua vaga? Nossos horários costumam preencher rápido! Posso agendar para você agora mesmo. 😊"

PREÇOS LABORATORIAIS: 17OH-Progesterona R$40 | Ácido fólico R$30 | Ácido pirúvico R$15 | Ácido úrico R$12 | Ácido valproico R$42 | Ácido vanil mandélico R$25 | ACTH R$35 | Albumina R$22 | Aldolase R$22 | Aldosterona R$30 | Alfa-1 antitripsina fecal R$15 | Alfa-1 antitripsina sérica R$15 | Alfa-1 glicoproteína ácida R$15 | Alfa-2 macroglobulina R$15 | Alfa fetoproteína R$45 | Alumínio R$65 | Alumínio urina R$65 | Amilase R$12 | Amilase U24H R$12 | Amilase U8H R$12 | Amilase urina R$12 | AMP cíclico U24H R$35 | AMP cíclico urinário R$35 | Anatomopatológico biópsia R$150 | Androstenediona R$30 | Antibiograma R$20 | Anti-cardiolipina IgM R$60 | Anti-cardiolipina IgA R$70 | Anti-cardiolipina IgG R$60 | Anti-células parietais R$80 | Anti-centrômero R$35 | Anti-citrulina CCP R$115 | Anticoagulante lúpico R$90 | Anti-DNA R$42 | Anti-DNA nativo R$25 | Anti-DNAse B R$27 | Anti-endomísio IgA R$90 | Anti-endomísio IgG R$90 | Antiestreptolisina O R$12 | CEA R$40 | Antígeno NS1 dengue R$70 | Anti-gliadina IgA R$50 | Anti-insulina R$98 | Anti-LKM1 R$50 | Anti-mitocôndria R$35 | Anti-Mülleriano R$110 | Anti-músculo estriado R$35 | Anti-músculo liso R$35 | ANCA R$85 | C-ANCA R$75 | Anti-nucleossomo R$75 | Anti-TPO R$35 | Anti-receptor TSH TRAB R$60 | Anti-RNP R$35 | Anti-SCL70 R$25 | Anti-SM R$40 | Anti-SSA/RO R$35 | Anti-SSB/LA R$35 | Anti-tireoglobulina R$35 | Anti-transglutaminase IgA R$95 | Antitrombina III R$65 | Apolipoproteína A R$75 | Apolipoproteína B R$75 | Atestado aptidão física R$50 | Atividade reumática R$50 | BAAR cultura escarro R$15 | BAAR cultura escarro seriada R$40 | BAAR pesquisa diversos R$25 | BAAR pesquisa escarro R$22 | BAAR pesquisa escarro seriada R$60 | BAAR pesquisa urina R$25 | BAAR pesquisa urina seriada R$15 | Bacterioscopia R$12 | Benzodiazepínicos pesquisa R$32 | Beta glicuronidase R$12 | Beta-HCG quantitativo R$50 | Bicarbonato R$25 | Bilirrubina direta R$12 | Bilirrubinas R$12 | Bilirrubina total R$12 | Biópsia R$150 | Biotinidase R$25 | BNP R$85 | Brucelose anticorpos R$15 | C3 complemento R$35 | C4 complemento R$35 | CA125 R$40 | CA19/9 R$50 | Cálcio R$10 | Calprotectina fecal R$90 | P-ANCA R$60 | Ceruloplasmina R$30 | Chikungunya IgG R$42 | Chikungunya IgM R$50 | Chumbo R$48 | Citologia meio líquido R$50 | CMV IgG R$25 | CMV IgM R$25 | Clamydia IgG R$35 | Clamydia IgM R$35 | Clearance creatinina R$15 | Coagulograma completo R$35 | Cobre R$40 | Colesterol R$12 | HDL R$14 | LDL R$14 | VLDL R$14 | Lipidograma R$38 | Coombs direto R$15 | Coombs indireto R$15 | Coprocultura R$18 | Coprologia funcional R$45 | Cortisol R$20 | CK-MB R$20 | Creatinina R$12 | CPK R$15 | Cultura quantitativa R$40 | Curva glicêmica 2 dosagens R$18 | Curva glicêmica 3 dosagens R$30 | Curva glicêmica 4 dosagens R$24 | Curva glicêmica 5 dosagens R$28 | Dengue IgG/IgM R$50 | HPV molecular R$95 | DHEA R$25 | DHL R$18 | DHT R$40 | Dímero-D R$90 | Dismorfismo eritrocitário R$25 | ECG R$50 | Eletroforese hemoglobinas R$25 | Eletroforese proteínas R$26 | HIV ELISA R$35 | Eritrograma R$14 | Espermograma R$30 | Estradiol R$20 | Estrona R$28 | FAN R$35 | Fator reumatoide R$14 | Fenilcetonúria R$20 | Fenitoína R$42 | Fenobarbital R$25 | Ferritina R$22 | Ferro R$12 | Fibrinogênio R$15 | Fosfatase alcalina R$12 | Fósforo R$12 | Frutosamina R$20 | FSH R$15 | FTA-ABS IgG R$25 | FTA-ABS IgM R$25 | Fungos cultura R$40 | Fungos pesquisa R$20 | G6PD R$20 | Galactosemia R$15 | Gama-GT R$15 | Gasometria R$110 | Gastrina R$70 | Glicemia casual R$10 | Glicemia jejum R$15 | Glicose jejum R$15 | Glicemia pós-prandial R$10 | Glicemia pós-sobrecarga R$10 | SHBG R$36 | Gordura fecal 24h R$15 | Gordura fecal pesquisa R$15 | Grupo sanguíneo Fator RH R$20 | Tipagem sanguínea R$20 | Fator Rh R$20 | Haptoglobina R$32 | Heinz corpúsculos R$15 | Helicobacter Pylori IgG R$35 | Helicobacter Pylori IgM R$35 | Helmintos fezes R$12 | Hemocultura R$25 | HbA1c R$24 | Hemoglobina glicada R$24 | Hemograma R$20 | VHS R$15 | Hemossedimentação R$15 | Hepatite A IgG R$36 | Hepatite A IgM R$36 | Hepatite B Anti-HBc IgM R$25 | Hepatite B Anti-HBc total R$25 | Hepatite B Anti-HBe R$36 | Hepatite B Anti-HBs R$25 | Anti-HBs R$25 | Hepatite B HBeAg R$36 | HBsAg R$25 | Hepatite C Anti-HCV R$30 | Anti-HCV R$30 | Hepatite D Anti-HDV R$40 | Herpes I/II IgG R$50 | Herpes I/II IgM R$50 | Herpes Zoster IgM R$50 | Herpes Zoster IgG R$50 | HIV PCR quantitativo R$400 | HIV Western Blot R$280 | HLA-B27 R$50 | Homocisteína R$42 | HTLV1/2 R$40 | IgA R$30 | IgE específica R$75 | IgE total R$20 | IGF1 somatomedina R$25 | Imunofixação sérica R$80 | Insulina R$15 | Insulina HOMA R$18 | Insulina pós-prandial R$15 | Intolerância lactose R$65 | Lactose prova R$30 | LH R$15 | Linfócitos CD4 R$85 | Linfócitos CD8 R$85 | Lipase R$12 | Lítio R$26 | Magnésio R$10 | Manobra Epley R$120 | MAPA 24h R$120 | Microalbuminúria U24H R$20 | Microalbuminúria isolada R$20 | Mucoproteínas R$15 | Oxiúrus R$14 | Painel DSTs 7 patógenos R$150 | Parasitológico R$15 | Parasitológico 3 amostras R$38 | PCR quantitativo R$22 | Proteína C reativa PCR R$14 | PCR ultrassensível R$25 | Peptídeo C R$40 | Potássio R$10 | Progesterona R$22 | Prolactina R$20 | Proteínas totais frações R$12 | Proteínas urina R$14 | Proteinúria 24h R$12 | Prova do laço R$12 | PSA total R$38 | PSA livre/total R$40 | PTH paratormônio R$50 | PAAF biópsia R$100 | Reticulócitos R$14 | Retirada corpo estranho ouvido R$80 | Retirada corpo estranho nasal R$100 | Sangue oculto isolado R$20 | Sangue oculto seriado R$50 | Sarampo IgM R$55 | Sarampo IgG R$50 | SDHEA R$30 | Sedimentoscopia U12H R$14 | Sedimentoscopia U24H R$14 | Selênio R$18 | Serotonina R$20 | Sexagem fetal R$165 | Sódio R$10 | T3 livre R$28 | T4 livre R$25 | T3 total R$25 | T4 total R$25 | TP tempo protrombina R$12 | TTPA R$18 | Tempo tromboplastina parcial R$18 | Teste genético lactose R$100 | Teste paternidade R$200 | Testosterona livre R$28 | Testosterona total R$22 | Tireoglobulina R$30 | Toxoplasmose IgM R$25 | Toxoplasmose IgG R$25 | TGO R$15 | TGP R$15 | Transferrina R$15 | Triglicerídeos R$14 | Troponina R$36 | Trypanosoma Cruzi IgG R$18 | Trypanosoma Cruzi IgM R$18 | TSH R$26 | Urina I R$14 | EAS R$14 | Urinálise R$14 | Ureia R$12 | Urinocultura R$20 | Urobilinogênio R$12 | Urocultura + antibiograma R$30 | Urocultura com antibiograma R$30 | Urocultura contagem colônias R$30 | Urocultura R$18 | VDRL R$12 | Vitamina A R$55 | Vitamina B1 R$150 | Vitamina B12 R$30 | Vitamina B6 R$80 | Vitamina C R$45 | Vitamina D R$36 | Vitamina E R$110 | Zinco R$25
COMPORTAMENTO DE VENDAS — CONVERSÃO DE ORÇAMENTOS
Sua missão ao apresentar orçamentos não é apenas informar valores — é converter em agendamento confirmado.

FECHAMENTO APÓS ORÇAMENTO — use variações naturais, nunca pressione:
✔ "Posso já deixar reservado para você?"
✔ "Prefere vir esta semana ou na próxima?"
✔ "Qual período fica melhor — manhã ou tarde?"
✔ "É só me confirmar o dia e eu já organizo tudo para sua chegada!"
✔ "Posso garantir sua vaga agora mesmo, é rapidinho! 😊"

NUNCA USE frases como "nossos horários costumam preencher rápido" — soa forçado.
NUNCA pressione o cliente. O tom é sempre de facilidade e cuidado, não de urgência artificial.

SE O CLIENTE DISSER QUE VAI PENSAR:
"Claro, sem pressa! 😊 Se tiver alguma dúvida sobre os exames ou quiser saber mais sobre como funciona o atendimento aqui, pode me perguntar. Fico à disposição!"

SE O CLIENTE ESTIVER PESQUISANDO PREÇOS:
"Faz todo sentido comparar! Além do valor, o que costuma fazer diferença mesmo é a qualidade do resultado e a agilidade na entrega. Aqui você tem os dois. Se quiser, posso já reservar um horário sem compromisso enquanto você decide?"

PROIBIDO:
❌ "Nossos horários costumam preencher rápido"
❌ Qualquer urgência artificial ou pressão
❌ Encerrar sem convite para agendar
❌ Responder orçamento só com números

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

// Corrige saudação automaticamente caso o modelo erre
function corrigirSaudacao(texto) {
  const hora = parseInt(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
  const saudacaoCorreta = hora >= 5 && hora < 12 ? 'Bom dia' : hora >= 12 && hora < 18 ? 'Boa tarde' : 'Boa noite';
  // Substitui saudação no início da mensagem, se houver
  return texto.replace(/^(Bom dia|Boa tarde|Boa noite)([!,.])/i, saudacaoCorreta + '$2');
}

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
    function diaDaSemana(dia, mes) {
      const dias = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
      return dias[new Date(2026, mes-1, dia).getDay()];
    }
    // Tabela de referência de dias da semana de junho/2026 para o modelo usar
    const tabelaDias = [];
    for (let d = 1; d <= 30; d++) {
      tabelaDias.push(d.toString().padStart(2,'0') + '/06=' + diaDaSemana(d,6).slice(0,3));
    }
    const refDiasSemana = tabelaDias.join(', ');
    const agendaFiltrada = [
      dataFutura(7,7) ? '• Psiquiatria: 07/07 das 13h30–17h00 — SOMENTE TARDE' : '• Psiquiatria: sem agenda disponível no momento',
      dataFutura(30,6) ? '• Otorrinolaringologia: 30/06 das 08h00–11h30 — SOMENTE MANHÃ' : '• Otorrinolaringologia: sem agenda disponível no momento',
      dataFutura(30,6) ? '• Endocrinologia: 30/06 das 13h00–17h30 — SOMENTE TARDE' : '• Endocrinologia: sem agenda disponível no momento',
      dataFutura(6,7) ? '• Ginecologia: 06/07 das 13h30–17h15 — SOMENTE TARDE' : '• Ginecologia: sem agenda disponível no momento',
      (function() {
        const dias = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
        const horarios = {
          1: 'Segunda: 08h00–10h45 e 16h00–17h15',
          2: 'Terça: 08h00–11h30',
          3: 'Quarta: 08h00–11h30',
          4: 'Quinta: 08h00–11h30 e 14h00–17h15',
          5: 'Sexta: 08h00–11h30'
        };
        const disponiveis = [];
        for (let i = 0; i <= 6; i++) {
          const d = new Date(nowBR);
          d.setDate(d.getDate() + i);
          const dow = d.getDay();
          if (horarios[dow]) {
            const dd = String(d.getDate()).padStart(2,'0');
            const mm = String(d.getMonth()+1).padStart(2,'0');
            disponiveis.push(dd + '/' + mm + ' (' + horarios[dow] + ')');
          }
        }
        return '• Clínico Geral/Pediatria (próximos dias): ' + (disponiveis.length ? disponiveis.slice(0,3).join(' | ') : 'sem agenda no momento');
      })(),
      '• Ultrassom: ' + (dataFutura(26,6) ? '26/06 das 07h30–09h15 e 17h00–18h00' : 'sem agenda no momento'),
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
      + '\n\nDATA/HORA ATUAL (Brasília): ' + agora + ' — Hoje é ' + diaSemana + ', ' + dataHoje
      + '\n\nTABELA DE DIAS DA SEMANA JUNHO/2026 (use SEMPRE esta tabela para informar dia da semana de qualquer data — NUNCA calcule de memória): ' + refDiasSemana
      + '\n\nREGRA OBRIGATÓRIA DE SAUDAÇÃO: Agora são ' + hora + 'h em Brasília. Se a resposta começar com saudação, USE EXATAMENTE "' + saudacao + '". NUNCA use "Boa noite" se a hora atual for ' + hora + 'h. Se for encerrar a conversa, use "' + despedida + '".';

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


// Estado de conversa persistido no Supabase
async function getEstado(num) {
  try {
    const { data } = await db.supabase.from('estado_conversa').select('dados').eq('telefone', num).single();
    return (data && data.dados) ? data.dados : {};
  } catch(e) { return {}; }
}

async function atualizarEstado(num, dados) {
  try {
    const atual = await getEstado(num);
    const novo = Object.assign({}, atual, dados);
    await db.supabase.from('estado_conversa').upsert({ telefone: num, dados: novo, updated_at: new Date().toISOString() });
  } catch(e) { console.error('ERRO atualizarEstado:', e.message); }
}

async function limparEstado(num) {
  try {
    await db.supabase.from('estado_conversa').delete().eq('telefone', num);
  } catch(e) {}
}

// Períodos fixos por especialidade/data
const PERIODOS_FIXOS = {
  'Psiquiatria': 'tarde',
  'Endocrinologia': 'tarde',
  'Otorrinolaringologia': 'manha',
  'Ginecologia_25': 'manha',  // 25/06
  'Ginecologia_29': 'tarde',  // 29/06
};

function inferirPeriodo(especialidade, dataEscolhida) {
  if (!especialidade) return null;
  const esp = especialidade.toLowerCase();
  const data = (dataEscolhida || '').toLowerCase();
  if (esp.includes('psiquiatria')) return 'tarde';
  if (esp.includes('endocrinolog')) return 'tarde';
  if (esp.includes('otorrino')) return 'manha';
  if (esp.includes('ginecolog')) return 'tarde';
  if (esp.includes('clínico') || esp.includes('clinico') || esp.includes('pediatr')) {
    if (data.includes('22')) return 'manha'; // 22/06 só tem manhã
  }
  return null;
}
function extrairDadosMensagem(texto) {
  const dados = {};
  // Detecta data de nascimento
  const nascMatch = texto.match(/\b(\d{2}[\/-]\d{2}[\/-]\d{4})\b/);
  if (nascMatch) dados.nascimento = nascMatch[1].replace(/\//g, '/');
  // Detecta nome
  const nomeMatch = texto.match(/([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+){1,4})(?:\s+\d|$)/);
  if (nomeMatch) dados.nome = nomeMatch[1].trim();
  // Detecta especialidade
  const t = texto.toLowerCase();
  if (t.match(/psiquiat/)) dados.especialidade = 'Psiquiatria';
  else if (t.match(/ginecolog/)) dados.especialidade = 'Ginecologia';
  else if (t.match(/endocrinolog/)) dados.especialidade = 'Endocrinologia';
  else if (t.match(/otorrino/)) dados.especialidade = 'Otorrinolaringologia';
  else if (t.match(/pediatr/)) dados.especialidade = 'Pediatria';
  else if (t.match(/cl[íi]nico|clinico geral/)) dados.especialidade = 'Clínico Geral';
  else if (t.match(/ultrassom|usg/)) dados.especialidade = 'Ultrassom';
  // Detecta período explícito
  if (t.match(/\btarde\b|17h|13h|14h/)) dados.periodo = 'tarde';
  else if (t.match(/\bmanh[ãa]\b|manha\b|08h|09h|10h|11h/)) dados.periodo = 'manha';
  // Detecta data escolhida (ex: 25/06, 29/06, dia 25, dia 29)
  const dataMatch = texto.match(/\b(\d{1,2})[\/-](\d{2})\b/) || texto.match(/\bdia\s+(\d{1,2})/);
  if (dataMatch) dados.dataEscolhida = dataMatch[0];
  return dados;
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
        hist.push({ role: 'user', content: 'O paciente enviou uma imagem/receita médica. Análise da imagem: ' + leitura + '\n\nCom base nos exames identificados, siga estas instruções:\n1. Confirme quais exames foram identificados\n2. Calcule o orçamento usando a tabela de preços (aplique as regras de preço especial se necessário)\n3. Informe APENAS os valores finais: 💳 Cartão e 💵 Pix/Dinheiro (sem mostrar valores individuais, sem mencionar percentuais)\n4. Convide para agendar\nSe não conseguir calcular algum exame por não estar na tabela, mencione que entrará em contato para complementar o orçamento.' });
        const resp = await chamarIA(hist);
        const final = limpar(resp).replace('[SECRETARIA]', '').trim();
        await db.salvarMensagem(num, 'assistant', final);
        await enviar(num, final);
        console.log('IMAGEM [' + num + ']: orçamento enviado');
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
      await limparEstado(num); // limpa estado ao reativar
      console.log('CMA reativada [' + num + ']');
      filas[num].rodando = false; processarFila(num); return;
    }

    if (await emAtendimentoHumano(num)) { filas[num].rodando = false; processarFila(num); return; }
    if (!txtCompleto.trim()) { filas[num].rodando = false; processarFila(num); return; }

    // Atualiza estado com dados desta mensagem
    const dadosMsg = extrairDadosMensagem(txtCompleto);
    await atualizarEstado(num, dadosMsg);
    // Infere período pela especialidade+data — SEMPRE sobrescreve período do texto
    const estadoTemp = await getEstado(num);
    if (estadoTemp.especialidade) {
      const periodoInferido = inferirPeriodo(estadoTemp.especialidade, estadoTemp.dataEscolhida || '');
      if (periodoInferido) await atualizarEstado(num, { periodo: periodoInferido });
    }
    const estadoAtual = await getEstado(num);
    console.log('ESTADO [' + num + ']:', JSON.stringify(estadoAtual));

    await db.salvarMensagem(num, 'user', txtCompleto);
    cacheAdicionarMensagem(num, 'user', txtCompleto);
    let hist = await buscarHistoricoComCache(num);
    hist = hist.filter(function(m){return m.content && m.content.trim();});
    if (hist.length === 0 || hist[hist.length-1].role !== 'user') {
      hist.push({ role: 'user', content: txtCompleto });
    }
    console.log('HIST [' + num + ']: ' + hist.length + ' msgs');

    // Verifica se tem todos os dados para agendar automaticamente
    const temTudo = estadoAtual.especialidade && estadoAtual.nome && estadoAtual.nascimento && estadoAtual.periodo;

    if (temTudo) {
      const instrucao = '[DADOS COLETADOS - FINALIZE O AGENDAMENTO: nome=' + estadoAtual.nome + ' | nascimento=' + estadoAtual.nascimento + ' | especialidade=' + estadoAtual.especialidade + ' | periodo=' + estadoAtual.periodo + '. Gere a tag [AGENDAR:nome=' + estadoAtual.nome + '|nascimento=' + estadoAtual.nascimento + '|especialidade=' + estadoAtual.especialidade + '|convenio=particular|periodo=' + estadoAtual.periodo + '] e confirme com a mensagem de sucesso.]';
      hist.push({ role: 'user', content: instrucao });
      console.log('AUTO-AGENDAR [' + num + ']:', estadoAtual.especialidade, estadoAtual.nome, estadoAtual.nascimento, estadoAtual.periodo);
    } else if (estadoAtual.especialidade && estadoAtual.periodo) {
      // Tem especialidade e período — só falta nome/nascimento
      const faltaNome = !estadoAtual.nome;
      const faltaNasc = !estadoAtual.nascimento;
      const oque = faltaNome && faltaNasc ? 'nome completo e data de nascimento juntos (ex: João Silva 15/03/1990)' : faltaNome ? 'nome completo' : 'data de nascimento';
      hist.push({ role: 'user', content: '[INSTRUÇÃO: Especialidade=' + estadoAtual.especialidade + ', período=' + estadoAtual.periodo + (estadoAtual.dataEscolhida ? ', data=' + estadoAtual.dataEscolhida : '') + '. NÃO pergunte especialidade, data ou período. APENAS peça: ' + oque + '.]' });
      console.log('PEDIR_DADOS [' + num + ']: falta=' + oque);
    } else if (estadoAtual.especialidade) {
      hist.push({ role: 'user', content: '[LEMBRETE: Especialidade já definida: ' + estadoAtual.especialidade + '. NÃO pergunte especialidade.' + (estadoAtual.periodo ? ' Período: ' + estadoAtual.periodo + '.' : '') + (estadoAtual.dataEscolhida ? ' Data: ' + estadoAtual.dataEscolhida + '.' : '') + ']' });
      console.log('LEMBRETE [' + num + ']: esp=' + estadoAtual.especialidade);
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
    const final = corrigirSaudacao(limpar(resp).replace('[SECRETARIA]','').replace(/🔹.*?transferindo.*?[\n\r]?/gi,'').trim());
    await db.salvarMensagem(num, 'assistant', final);
    cacheAdicionarMensagem(num, 'assistant', final);
    await enviar(num, final);
    // Limpa estado após agendamento confirmado
    if (ag) await limparEstado(num);

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
  if (MODO_TESTE && !NUMEROS_TESTE.includes(num)) return; // modo teste: só números autorizados

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

app.get('/test-quark', async function(req, res) {
  try {
    const QUARK_HEADERS = {
      'Content-Type': 'application/json',
      'Auth-token': 'bgdWIDWVoYDQBtFLLlblOQpDoalqBbWXJbezRxVhbujmivbakllRWcAoHcxMHqbk',
      'X-Chave-Key': '5196e91382b959a96f18aa61485c30de2a6b9f42241d4b0d5b3fe5426758dc95',
      'X-Secret-Key': 'f7c217f2aeeef1ea6fc2db2aa22a028dee1246989e52c21866515b2de25bbecb'
    };
    const BASE = 'https://api.quark.tec.br/clinic/ext';
    const r = await axios.get(BASE + '/v1/procedimentos', { headers: QUARK_HEADERS, timeout: 10000 });
    res.json({ ok: true, total: Array.isArray(r.data) ? r.data.length : '?', amostra: Array.isArray(r.data) ? r.data.slice(0,5) : r.data });
  } catch(e) {
    res.status(500).json({ erro: e.message, status: e.response ? e.response.status : null, data: e.response ? e.response.data : null });
  }
});

app.get('/', function(req, res) { res.json({ status: 'online', agente: 'CMA v3', uptime: Math.floor(process.uptime())+'s' }); });
app.listen(PORT, function() { console.log('América — CMA v3 | Porta: ' + PORT + ' | Online'); });
