const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
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
  '5562996092636',
  '5562984271335', // Dr. Wilder — retirado da lista de números de teste
];

// Normaliza telefone para comparação: remove tudo que não é dígito e tira o "9" extra
// do celular (Brasil) quando presente, para números baterem independente do formato
// que a Z-API mandar (com ou sem esse dígito).
function normalizarTelefone(num) {
  const digitos = String(num || '').replace(/\D/g, '');
  let semPais = digitos.startsWith('55') ? digitos.slice(2) : digitos;
  const ddd = semPais.slice(0, 2);
  let local = semPais.slice(2);
  if (local.length === 9 && local[0] === '9') local = local.slice(1);
  return ddd + local;
}
const NUMEROS_IGNORAR_NORMALIZADOS = NUMEROS_IGNORAR.map(normalizarTelefone);
function numeroEstaIgnorado(num) {
  return NUMEROS_IGNORAR_NORMALIZADOS.includes(normalizarTelefone(num));
}

const cacheHumano = {};

// MODO TESTE LABORATORIAL — orçamentos de exames só para esses números
const NUMEROS_TESTE_LAB = [
  '556284227156',
];
const MODO_TESTE = false; // quando true, bloqueia TUDO para não listados
const MODO_TESTE_LAB = false; // liberado para todos os clientes
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
• Psiquiatria: 07/07, 21/07, 07/08 e 21/08 das 13h30–17h00 — SOMENTE TARDE
• Otorrinolaringologia: 27/07 das 13h30–17h00 — SOMENTE TARDE
• Endocrinologia: 04/08 das 14h00–17h00 — SOMENTE TARDE
• Ginecologia: 31/07, 14/08 e 28/08 das 13h00–16h00 — SOMENTE TARDE
• Clínico Geral/Pediatria — datas específicas (cada uma com seu horário):
  - 20/07: manhã 09h00–10h30 e tarde 16h00–17h15
  - 23/07: manhã 08h00–11h30 e tarde 14h00–17h00

REGRA DE DATAS: Compare cada data com a DATA ATUAL do prompt. Mostre SOMENTE datas futuras. Cada data tem horário diferente — informe corretamente conforme a agenda acima. Se TODAS passaram: informe que não há agenda disponível no momento.

PERÍODO: Para Clínico Geral/Pediatria, mostre as datas futuras disponíveis e os horários de cada uma (algumas só têm manhã, outras têm manhã e tarde) — pergunte qual data e período o paciente prefere, dentro do que está disponível para cada dia. Para demais especialidades use o período fixo sem perguntar.

ULTRASSOM
Não é especialidade — é exame. Colete: nome, nascimento, qual exame.
Tag: [AGENDAR:nome=X|nascimento=X|especialidade=Ultrassom|convenio=particular|periodo=manha]
Dias disponíveis: TERÇA, 14h00–17h30 (tarde), e SEXTA, 07h00–09h45 (manhã) e 17h00–18h00 (tarde) — TODOS os exames de ultrassom são feitos nesses dias.
MORFOLÓGICO: 1ºTri=11–13sem6d(R$230) | 2ºTri=20–23sem6d(R$280) | 3ºTri=32–34sem6d.
REGRA CRÍTICA MORFOLÓGICO: se o paciente responder diretamente "1º trimestre", "1 trimestre", "primeiro trimestre", "2º trimestre", "segundo trimestre" (sem informar semanas exatas), ACEITE essa resposta como suficiente para identificar qual exame ele quer. NÃO peça semanas exatas de novo — isso já responde qual dos dois exames é. Prossiga direto para confirmar e pedir nome+nascimento. Só peça semanas exatas se o paciente não souber dizer o trimestre.

PREÇOS ULTRASSOM: Abdome Inf R$70|c/Dop R$160 | Abdome Sup R$80|c/Dop R$160 | Abdome Total R$100|c/Dop R$350 | Articulação R$80 | Bolsa Escrotal R$80|c/Dop R$150 | Mamas R$90 | Morfológica 1ºTri R$230|2ºTri R$280 | Obstétrica>14sem R$100|c/Dop R$280|Endovaginal R$100|Múltipla R$180 | Partes Moles R$70 | Próstata R$90 | Quadril Ped R$80 | Tireoide R$90|c/Dop R$150 | Transvaginal R$90|c/Dop R$160 | Vias Urinárias R$80 | Transfontanela R$130 | Pélvica R$80 | Punho R$80 | Parede Abd R$80 | Parótidas R$70|c/Dop R$160 | Pé R$80 | Quadril Ad R$80 | Orelha R$70 | Cervical R$80 | Ombro R$90 | Inguinal R$80 | Axilas (cada lado) R$70 | Doppler Isolado R$140 | Doppler Carótidas R$150.

CONSULTAS: Clínico Geral R$80 | Ginecologia R$120 | Endocrinologia R$120 | Psiquiatria R$120 | Pediatria R$100 | Otorrino R$140.
PROCEDIMENTOS: Limpeza ouvido R$50 | DIU inserir R$400 | DIU retirar R$300 | Prevenção R$80 | Retirada pontos R$50.
ATENÇÃO — BIÓPSIA: a clínica NÃO faz coleta/procedimento de biópsia. Só realiza a ANÁLISE de uma amostra que o paciente já tenha coletado em outro lugar. Se o paciente perguntar sobre "coleta de biópsia" ou agendar a coleta em si, explique que isso não é feito aqui — só recebemos a amostra já coletada para análise.
EXAMES CARDIOLÓGICOS: Holter 24h R$150 | MAPA 24h R$140 | Eletrocardiograma R$50.

ATENÇÃO — SEXAGEM FETAL: nesta clínica, Sexagem Fetal é um EXAME DE SANGUE laboratorial (coleta de sangue materno), NÃO é ultrassom. NÃO trate como exame de imagem, NÃO aplique a agenda de ultrassom (sexta-feira) para ele. Ele segue a AGENDA DE COLETA LABORATORIAL normal (abaixo), disponível nos dias de coleta, não só sexta-feira. Valor: R$165,00, sem desconto no pix (mesmo valor no cartão e à vista).

ATENÇÃO — BETA-HCG: valor R$50,00, SEM desconto no pix (mesmo valor no cartão e à vista) — igual à Sexagem Fetal. NUNCA aplique os 10% de desconto normal do laboratório nesse exame específico, mesmo se vier junto com outros exames que têm desconto.

AGENDA DE COLETA LABORATORIAL — 07h00 às 09h45:
Use SEMPRE as datas exatas fornecidas no bloco "AGENDA ATUAL" do prompt (calculadas pelo sistema) — NUNCA calcule ou deduza essas datas sozinho.

EXAMES LABORATORIAIS: A clínica FAZ exames laboratoriais. NUNCA negar. Quando paciente perguntar preço de exame(s), calcule o total e informe APENAS o valor total com as opções de pagamento — não liste os valores individuais. Para orçamento de pedido médico com foto: peça a foto/lista, depois use [SECRETARIA].
REGRA DE NUMERAÇÃO: sempre que for listar os nomes dos exames identificados (por foto ou por texto digitado), liste NUMERADOS (1. 2. 3. ...), para o paciente ver de forma clara quantos exames foram identificados. Isso vale só para os NOMES dos exames — os VALORES continuam sendo mostrados apenas como total final (cartão/pix), nunca por item.
EXAMES QUE A CLÍNICA NÃO FAZ: Tomografia (TC/TAC) e Ressonância Magnética (RM/RNM) NÃO são feitos aqui. Se algum desses aparecer no pedido/receita (ex: "TC de Abdome Total", "Ressonância de Crânio"), NÃO diga que "será tratado à parte" — avise CLARAMENTE e direto ao paciente, já na mesma mensagem, que a clínica não realiza esse exame específico e que ele precisa procurar outro local para isso. Continue normalmente com o orçamento dos demais exames que a clínica faz.

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
- Os valores da tabela JÁ SÃO o preço do cartão (não aplique nenhum acréscimo sobre eles). Para pagamento à vista (pix ou dinheiro), conceda 10% de desconto sobre o valor da tabela. Essa regra se aplica SOMENTE a exames laboratoriais
- Para ultrassom, consultas e procedimentos: informe o preço fixo diretamente, SEM aplicar percentuais, SEM mencionar desconto ou acréscimo
- Se o paciente perguntar "qual forma de pagamento?" depois de já saber o valor de um ultrassom/consulta/procedimento, NÃO diga "sem acréscimo" nem repita qualquer variação dessa frase — apenas confirme que aceita cartão e pix/dinheiro pelo mesmo valor já informado. Exemplo correto: "Aceitamos cartão de crédito e pix/dinheiro, ambos por R$XX,XX. 😊"
- Para exames laboratoriais: cartão = valor da tabela (sem nenhuma alteração) | pix = total × 0.90 (desconto de 10%) — mostre apenas os dois valores finais SEM mencionar percentuais
- Acima de R$299 no cartão: parcela em até 3x (mencione isso). Abaixo de R$299: NUNCA mencione parcelamento, nem para dizer que "não se aplica" — simplesmente não toque no assunto
- OBRIGATÓRIO em TODO orçamento laboratorial (nunca pule essa parte): depois de mostrar os valores, avise de forma natural e calorosa que esse é um valor PRÉVIO e que a secretaria vai confirmar com o paciente o valor final e se todos os exames foram identificados certinho. NÃO use linguagem de aviso legal/disclaimer frio — fale como se fosse a própria América explicando com cuidado. Essa regra vale SOMENTE para exames laboratoriais (não para ultrassom, consultas ou procedimentos, que já têm preço fixo e certo)
- Seja calorosa, humanizada e faça uma chamada para agendamento ao final, como neste exemplo:
"Olá! 😊 Segue a prévia do orçamento para os exames solicitados:
💳 Cartão de crédito: R$XX,XX
💵 Pix ou dinheiro: R$XX,XX
Esse valor é uma prévia com base no que identifiquei aqui — nossa secretaria vai entrar em contato com você em breve pra confirmar certinho o valor final e conferir se todos os exames foram identificados corretamente, tá bom? 😊
Enquanto isso, já quer garantir sua vaga? É só me confirmar o dia e o período que eu já organizo tudo para sua chegada!"

PREÇOS LABORATORIAIS: 17OH - PROGESTERONA R$42 | ACIDO FOLICO R$32 | ACIDO PIRUVICO R$16 | ACIDO URICO R$13 | ACIDO VALPROICO R$44 | ACIDO VANIL MANDELICO R$26 | ACTH, HORMONIO ADRENOCORTICOTROFICO R$37 | ALBUMINA R$23 | ALDOLASE R$23 | ALDOSTERONA R$32 | ALFA-1 ANTITRIPSINA FECAL R$16 | ALFA-1 ANTITRIPSINA (SERICA) R$16 | ALFA-1 GLICOPROTEINA ACIDA R$16 | ALFA-2 MACROGLOBULINA R$16 | ALFA FETOPROTEINA R$47 | ALUMINIO R$68 | ALUMINIO URINA R$68 | AMILASE R$13 | AMILASE U24H R$13 | AMILASE U8H R$13 | AMILASE URINA AMOSTRA ISOLADA R$13 | AMP CICLICO U24H R$37 | AMP CICLICO URINARIO 2H JEJUM R$37 | AMP CICLICO URINARIO POS-SOBRECARGA R$37 | ANATOMOPATOLOGICO (BIOPSIA) R$157 | ANDROSTENEDIONA R$32 | ANTIBIOGRAMA AUTOMATIZADO R$22 | ANTI-CARDIOLIPINA EIE IGM R$63 | ANTI-CARDIOLIPINA IGA R$73 | ANTI-CARDIOLIPINA IGG R$63 | ANTI-CELULAS PARIETAIS R$84 | ANTI-CENTROMERO R$37 | ANTI-CITRULINA (CCP) R$120 | ANTICOAGULANTE LÚPICO R$94 | ANTI-DNA R$44 | ANTI-DNA-NATIVO, DUPLA HELICE R$27 | ANTI-DNASE B R$29 | ANTI-ENDOMISIO IGA R$94 | ANTI-ENDOMISIO IGG R$94 | ANTIESTREPTOLISINA O R$13 | ANTIGENO CARCINOEMBRIOGENICO - CEA R$42 | ANTIGENO NS1 DO VIRUS DA DENGUE, PESQUISA R$73 | ANTI-GLIADINA IGA R$52,50 | ANTI-INSULINA R$100 | ANTI-LKM1 R$52,50 | ANTI-MITOCONDRIA R$37 | ANTI-MULLERIANO R$115 | ANTI-MUSCULO ESTRIADO R$37 | ANTI-MUSCULO LISO R$37 | ANTI-NEUTROFILOS, ANCA R$89 | ANTI-NEUTROFILOS C-ANCA R$78 | ANTI-NUCLEOSSOMO R$78 | ANTI-PEROXIDASE (ANTI-TPO) R$37 | ANTI-RECEPTOR DE TSH, TRAB R$63 | ANTI-RNP R$37 | ANTI-SCL70, ESCLERODERMA R$27 | ANTI-SM R$43 | ANTI-SSA/RO R$37 | ANTI-SSB/LA R$37 | ANTI-TIREOGLOBULINA R$37 | ANTI-TRANSGLUTAMINASE IGA R$99 | ANTITROMBINA III R$67 | APOLIPOPROEINA A - APOA R$78 | APOLIPOPROEINA B - APOB R$78 | ATIVIDADE REUMATICA PROVAS R$52,50 | BAAR CULTURA ESCARRO AMOSTRA ISOLADA R$32 | BAAR CULTURA ESCARRO AMOSTRA SERIADA R$70,50 | BAAR PESQUISA DIVERSOS R$27 | BAAR PESQUISA ESCARRO AMOSTRA ISOLADA R$24 | BAAR PESQUISA ESCARRO AMOSTRA SERIADA (3AMOSTRAS) R$63 | BAAR PESQUISA URINA R$27 | BAAR PESQUISA URINA AMOSTRA SERIADA U24 R$16 | BACTERIOSCOPIA DIVERSOS R$15 | BENZODIAZEPINICOS, PESQUISA R$34 | BETA GLICURONIDASE R$13 | BETA-HCG QUANTITATIVO R$50 | BICARBONATO R$27 | BILIRRUBINA DIRETA R$13 | BILIRRUBINAS R$13 | BILIRRUBINA TOTAL R$13 | BIOPSIA R$157 | BIOTINIDASE SG R$27 | BNP - Peptídeo Natriurético Tipo B R$89 | BRUCELOSE ANTICORPOS R$16 | C3 COMPLEMENTO R$37 | C4 COMPLEMENTO R$37 | CA 125 R$42 | CA19/9 R$52,50 | CALCIO R$10 | CALPROTECTINA FECAL R$94,50 | C-ANCA R$63 | CERULOPLASMINA R$32,50 | CHIKUNGUNYA IGG R$44 | CHIKUNGUNYA IGM R$52,50 | CHUMBO R$52,50 | CITOLOGIA EM MEIO LIQUIDO R$52,50 | CITOMEGALOVÍRUS IGG R$27 | CITOMEGALOVÍRUS IGM R$27 | CLAMYDIA IGG R$37 | CLAMYDIA IGM R$37 | CLEARANCE DE CREATININA R$16 | COAGULOGRAMA COMPLETO R$37 | COBRE R$42 | COLESTEROL R$13 | COLESTEROL HDL R$15 | COLESTEROL LDL R$15 | COLESTEROL VLDL R$15 | COOMBS DIRETO R$16 | COOMBS INDIRETO R$16 | COPROCULTURA R$20 | COPROLOGIA FUNCIONAL R$47 | CORTISOL R$21 | CREATINA QUINASE CK-MB R$21 | CREATININA R$13 | CREATINOFOSFOQUINASE - CPK R$16 | CULTURA QUANTITATIVA DIVERSOS R$42 | CURVA GLICEMICA (2 Dosagens) R$18 | DENGUE (IgG/IgM) R$52,50 | DETECÇAO MOLECULAR DE HPV E RASTREAMENTO DO CA COLO DE UTERO R$99 | DHEA, DEHIDROEPIANDROSTERONA R$26 | DHL, DESIDROGENASE LATICA R$19 | DHT - DEHIDROTESTOSTERONA R$42 | DIMERO - D R$94,50 | DISMORFISMO ERITROCITARIO R$26 | ELETROFORESE DE HEMOGLOBINAS R$26 | ELETROFORESE DE PROTEINAS R$27 | ELISA HIV 1 E 2 PESQUISA DE ANTIGENO E ANTICORPO R$37 | ERITROGRAMA R$15 | ESTRADIOL R$21 | ESTRONA R$29 | FAN PESQUISA DIVERSOS R$37 | FATOR REUMATOIDE R$15 | FENILCETONURIA PESQUISA R$21 | FENITOINA R$44 | FENOBARBITAL R$26 | FERRITINA R$23 | FERRO R$13 | FIBRONOGENIO R$16 | FOSFATASE ALCALINA R$13 | FOSFORO R$13 | FRUTOSAMINA R$21 | FRUTOSE, TESTE DE TOLERÂNCIA R$33 | FSH - HORMONIO FOLICULO ESTIMULANTE R$16 | FTA-ABS IGG R$26 | FTA-ABS IGM R$26 | FUNGOS CULTURA DIVERSOS R$42 | FUNGOS PESQUISA DIVERSOS R$21 | G6PD - GLICOSE 6 FOSFATO DESIDROGENASE R$38 | GALACTOSEMIA SG R$16 | GAMA-GT, GAMA-GLUTAMIL TRANSFERASE R$16 | GASTRINA R$73,50 | GLICEMIA CASUAL R$10 | GLICEMIA DE JEJUM R$16 | GLICEMIA POS-PRANDIAL R$10 | GLICEMIA POS-SOBRECARGA COM GLICOSE R$12 | GLOBULINA LIGADORA DE HORMONIOS SEXUAIS, SHBG R$38 | GORDURA FECAL F24H R$16 | GORDURA FECAL PESQUISA R$16 | GRUPO SANGUINEO E FATOR RH R$21 | HAPTOGLOBINA R$33 | HEINZ CORPUSCULOS PESQUISA R$16 | HELICOBACTER PYLORI IGG R$37 | HELICOBACTER PYLORI IGM R$37 | HELMINTOS, IDENTIFICACAO, FEZES R$13 | HEMOCULTURA R$26,50 | HEMOGLOBINA GLICADA (HbA1c) R$25 | HEMOGRAMA R$21 | HEMOSSEDIMENTACAO, VHS R$16 | HEPATITE A: ANTI-HAV IGG R$38 | HEPATITE A: ANTI-HAV IGM R$38 | HEPATITE B: ANTI-HBC IGM R$26 | HEPATITE B: ANTI-HBC total R$26 | HEPATITE B: ANTI-HBE R$38 | HEPATITE B: ANTI-HBS R$26 | HEPATITE B: HBeAG R$38 | HEPATITE B: HBSAG R$26 | HEPATITE C: ANTI-HCV R$32 | HEPATITE D: ANTI-HDV R$42 | HERPES SIMPLES I/II IGG R$52,50 | HERPES SIMPLES I/II IGM R$52,50 | HERPES ZOSTER EIE IGM R$52,50 | HERPES ZOSTER IGG R$52,50 | HIV1 PCR QUANTITATIVO R$420 | HIV WESTERN BLOT R$295 | HLA-B27 R$52,50 | HOMOCISTEINA R$44 | HTLV1/2 ANTICORPOS R$42 | IGA *IMUNOGLOBULINA A R$32 | IGE ESPECÍFICA R$79 | IGE TOTAL R$21 | IGF1, SOMATOMEDINA C R$26 | IMUNOFIXAÇÃO SERICA R$84 | INSULINA R$16 | INSULINA HOMA IR E BETA R$19 | INSULINA POS-PRANDIAL R$16 | INTOLERANCIA A LACTOSE R$68 | LACTOSE PROVA DE ABSORCAO R$32 | LH - HORMONIO LUTEOTROFICO R$16 | LINFOCITOS CD4 R$89 | LINFOCITOS CD8 R$89 | LIPASE R$13 | LIPIDOGRAMA R$40 | LITIO R$27 | MAGNÉSIO R$10 | MICROALBUMINURIA U24H R$21 | MICROALBUMINURIA URINA AMOSTRA ISOLADA R$21 | MUCOPROTEINAS R$16 | OXIURUS PESQUISA SWAB ANAL R$15 | PAINEL DST'S 7 PATOGENOS R$157 | P-ANCA R$63 | PARASITOLOGICO - 3 AMOSTRAS (EPF3) R$40 | PARASITOLOGICO AMOSTRA ISOLADA (EPF) R$16 | PEPTIDEO C R$42 | POTASSIO R$10 | PROGESTERONA R$24 | PROLACTINA R$21 | PROTEINA C REATIVA ULTRASENSIVEL R$16 | PROTEINAS TOTAIS E FRACOES SERICAS R$13 | PROTEINAS URINA AMOSTRA ISOLADA R$15 | PROTEINURIA DE 24 HORAS R$15 | PSA LIVRE/TOTAL R$42 | PSA TOTAL R$40 | PTH, PARATORMONIO R$52,50 | RETICULOCITOS R$15 | RUBEOLA  IGG R$38 | RUBEOLA  IGM R$38 | SANGUE OCULTO AMOSTRA ISOLADA R$21 | SANGUE OCULTO (amostra seriada) R$52,50 | SARAMPO IGM R$58 | SARAMPO IGG R$52,50 | SDHEA, SULFATO DE DEHIDROEPIANDROSTERONA R$32 | SEDIMENTOSCOPIA CONTADA, ADDIS, U12H R$15 | SEDIMENTOSCOPIA CONTADA, U24H R$15 | SELENIO R$19 | SEROTONINA R$21 | SEXAGEM FETAL EM SANGUE MATERNO R$165 | SODIO R$10 | T3 LIVRE R$30 | T4 LIVRE R$26 | TEMPO DE PROTROMBINA (TP) R$13 | TEMPO DE TROMBOPLASTINA PARCIAL ATIVADO (TTPA) R$20 | TESTE GENETICO DE INTOLERANCIA A LACTOSE R$105 | TESTE PATERNIDADE - DUO PAI E FILHO R$210 | TESTOSTERONA LIVRE R$29,50 | TESTOSTERONA TOTAL R$23,50 | TIREOGLOBULINA R$32 | TIROXINA - T4 TOTAL R$26,50 | TOXOPLASMOSE EIE IGM R$26,50 | TOXOPLASMOSE IGG R$26,50 | Transaminase Glutâmico Oxalacética (TGO) R$16 | TRANSAMINASE GLUTÂMICO PIRÚVICA (TGP) R$16 | TRANSFERRINA R$16 | TRIGLICERIDES R$15,50 | TRI-IODOTIRONINA - T3 TOTAL R$26,50 | TROPONINA R$38 | TRYPANOSOMA CRUZI IGG (Chagas) R$32,50 | TRYPANOSOMA CRUZI IGM (Chagas) R$32,50 | TSH - HORMONIO TIREOESTIMULANTE R$28,50 | URANALISE (URINA I/EAS) R$15 | UREIA R$13 | URINOCULTURA AUTOMATIZADA R$21 | UROBILINOGENIO PESQUISA R$13 | UROCULTURA + ANTIBIOGRAMA R$32 | VDRL R$15 | VITAMINA A R$58 | VITAMINA B1 R$150 | VITAMINA B12 R$32 | VITAMINA B6 R$84 | VITAMINA C R$50 | VITAMINA D3 - 25 HIDROXI VITAMINA D R$38 | VITAMINA E R$82 | ZINCO R$26,50
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
- Ao confirmar um agendamento, use SEMPRE este formato estruturado (preencha com os dados reais da conversa — NUNCA invente horário exato, nome de médico ou consultório, pois o sistema não tem esses dados):
"*Seu atendimento foi confirmado!* ✅
📅 [dia da semana por extenso], [DD/MM/AAAA]
⏰ [Manhã ou Tarde]
🏥 [Especialidade/Exame]
📍 Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia-GO, CEP 74485-055

Chegue com uns 20 minutinhos de antecedência, tá bom? 😉 Nossa equipe vai confirmar tudo em breve. Posso ajudar em mais alguma coisa?"
- A data SEMPRE vem com o dia da semana por extenso na frente (ex: "Terça-feira, 14/07/2026") — use a TABELA DE DIAS DA SEMANA fornecida para acertar o dia certo, NUNCA calcule de memória.
- Endereço: Av. Frei Miguelino, 247 - Bairro Goiá, Goiânia-GO, CEP 74485-055.`;


// Tabela de preços para cálculo preciso
const TABELA_PRECOS = {
  'hemograma': 21,
  'hmg': 21,
  'glicemia': 16,
  'glicose': 16,
  'glicemia de jejum': 16,
  'glicemia casual': 10,
  'glicemia pos-prandial': 10,
  'glicose de jejum': 16,
  'glicose pos-prandial': 10,
  'glicose casual': 10,
  'hba1c': 25,
  'hemoglobina glicada': 25,
  'hb glicada': 25,
  'colesterol': 13,
  'colesterol total': 13,
  'colesterol hdl': 15, 'hdl': 15,
  'colesterol ldl': 15, 'ldl': 15,
  'colesterol vldl': 15, 'vldl': 15,
  'triglicerides': 15.5,
  'triglicerídeos': 15.5,
  'triglicerideos': 15.5,
  'dht': 42,
  'dehidrotestosterona': 42,
  'lipidograma': 40,
  'colesterol total e fracoes': 40,
  'colesterol e fracoes': 40,
  'lipodograma': 40,
  'lipidograma completo': 40,
  'perfil lipidico': 40,
  'perfil lipídico': 40,
  'creatinina': 13,
  'creatina': 13,
  'ureia': 13,
  'acido urico': 13,
  'ácido úrico': 13,
  'tgo': 16,
  'tgp': 16,
  'gama-gt': 16,
  'g.gt': 16,
  'ggt': 16,
  'ur e cr': 26,
  'ur/cr': 26,
  'gama gt': 16,
  'fosfatase alcalina': 13,
  'bilirrubinas': 13,
  'bilirrubina total': 13,
  'bilirrubina direta': 13,
  'proteinas totais e fracoes sericas': 13,
  'proteinas totais': 13,
  'proteinas totais e fracoes': 13,
  'pcr ultrassensivel': 16,
  'pcr': 15,
  'proteina c reativa': 15,
  'proteína c reativa': 15,
  'mucoproteinas': 16, 'muco-proteinas': 16, 'muco proteinas': 16,
  'tsh': 28.5,
  'trab': 63,
  'anti-receptor de tsh': 63,
  'ige especifica': 79,
  'ige específica': 79,
  'ige total': 21,
  'ige': 21,
  'c3': 37,
  'c3 complemento': 37,
  'c4': 37,
  'c4 complemento': 37,
  't3 livre': 30,
  't4 livre': 26,
  't4l': 26,
  't3 total': 26.5,
  't4 total': 26.5,
  't4': 26.5,
  't3': 26.5,
  'anti-tpo': 37,
  'anti tpo': 37,
  'tireoglobulina': 37,
  'ferritina': 23,
  'ferro': 13,
  'acido folico': 32,
  'folato': 32,
  'ácido fólico': 32,
  'vitamina b12': 32, 'vit b12': 32,
  'vitamina d': 38, 'vit d': 38, 'vitamina d3': 38,
  'microalbuminuria': 21, 'microalbuminuria u24h': 21, 'microalbuminuria urina amostra isolada': 21,
  '25 hidroxivitamina d': 38,
  'hidroxivitamina d': 38,
  'vitamina b6': 84,
  'vitamina c': 50,
  'vitamina a': 58,
  'vitamina e': 82,
  'zinco': 26.5,
  'selenio': 19,
  'selênio': 19,
  'magnesio': 10,
  'magnésio': 10,
  'litio': 27,
  'lítio': 27,
  'litemia': 27,
  'litemia serica': 27,
  'calcio': 10,
  'cálcio': 10,
  'sodio': 10,
  'sódio': 10,
  'potassio': 10,
  'potássio': 10,
  'fsh': 16,
  'lh': 16,
  'estradiol': 21,
  'progesterona': 24,
  'prolactina': 21,
  'testosterona total': 23.5,
  'testosterona livre': 29.5,
  'testosterona': 0,
  'dhea': 26,
  'shbg': 38,
  'anti-mulleriano': 115,
  'anti mülleriano': 115,
  'cortisol': 21,
  'acth': 37,
  'insulina homa ir e beta': 19, 'insulina homa ir': 19,
  'insulina': 16,
  'beta-hcg': 50,
  'sexagem fetal': 165,
  'beta hcg': 50,
  'bhcg': 50,
  'psa total': 40,
  'psa livre': 42,
  'psa livre/total': 42,
  'psa': 42,
  'vhs': 16,
  'hemossedimentacao': 16,
  'hemossedimentação': 16,
  'fator reumatoide': 15,
  'fator reumatóide': 15,
  'urina i': 15,
  'eas': 15,
  'uranalise': 15,
  'sedimento da urina': 15,
  'sedimentoscopia': 15,
  'elementos anormais e sedimentoscopia': 15,
  'urinálise': 15,
  'urocultura + antibiograma': 32,
  'cultura de bacterias': 32,
  'cultura de bacterias p identificacao': 32,
  'cultura de bacterias para identificacao': 32,
  'urocultura com antibiograma': 32,
  'urocultura antibiograma': 32,
  'uroc': 32,
  'urinocultura': 21,
  'antibiograma': 22,
  'parasitologico de fezes': 16,
  'parasitológico de fezes': 16,
  'parasitologico': 16,
  'parasitológico': 16,
  'epf': 16,
  'gpf': 16,
  'fezes': 16,
  'larvas nas fezes': 16,
  'pesquisa de larvas nas fezes': 16,
  'pesquisa de larvas': 16,
  'epf3': 40,
  'parasitologico 3 amostras': 40,
  'vdrl': 15,
  'hiv': 37,
  'hbsag': 26,
  'anti-hbs': 26,
  'anti hbs': 26,
  'hepatite b': 26,
  'hepatite c': 32,
  'anti-hcv': 32,
  'dengue': 52.5,
  'toxoplasmose': 26.5,
  'rubeola': 38,
  'rubéola': 38,
  'cmv': 27,
  'coombs direto': 16,
  'coombs indireto': 16,
  'eletroforese hemoglobinas': 26,
  'eletroforese de proteinas': 27,
  'anti-dna': 44,
  'antiestreptolisina o': 13, 'aslo': 13,
  'anti-nucleossomo': 78, 'antinucleo': 78, 'anticorpos antinucleo': 78,
  'eletroforese de hemoglobinas': 26,
  'eletroforese de hemoglobina': 26,
  'transferrina': 16,
  'sangue oculto amostra isolada': 21,
  'sangue oculto': 21,
  'pesquisa de sangue oculto nas fezes': 21,
  'pesquisa de sangue oculto': 21,
  'sangue oculto nas fezes': 21,
  'pcr quantitativo': 23,
  'coagulograma': 37,
  'tp': 13,
  'tempo de protrombina': 13,
  'tempo e atividade da protrombina': 13, 'tap': 13,
  'ttpa': 20,
  'dimero-d': 94.5,
  'dímero-d': 94.5,
  'grupo sanguineo e fator rh': 21,
  'grupo sanguíneo e fator rh': 21,
  'grupo sanguineo': 21,
  'grupo sanguíneo': 21,
  'fator rh': 21,
  'tipagem sanguinea': 21,
  'tipagem sanguínea': 21,
  'eritrograma': 15,
  'reticulocitos': 15,
  'reticulócitos': 15
};

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function calcularOrcamento(textoExames) {
  const txt = textoExames.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/hemoglobina\s*glic[ao]s?ilada|hemoglobina\s*glicada|hb\s*glicada|hb\s*-?\s*a1\s*c|hba1c/g, 'hba1c');

  // PASSO 1: encontra exames da tabela, exigindo BORDA DE PALAVRA (evita "lh" dentro de "conselho" etc.)
  let txtRestante = txt;
  const achados = [];
  const examesOrdenados = Object.keys(TABELA_PRECOS).sort((a, b) => b.length - a.length);

  for (const exame of examesOrdenados) {
    const re = new RegExp('(?:^|[^a-z0-9])(' + escapeRegex(exame) + ')(?:$|[^a-z0-9])');
    const m = re.exec(txtRestante);
    if (m) {
      achados.push({ chave: exame, valor: TABELA_PRECOS[exame] });
      const start = m.index + m[0].indexOf(m[1]);
      txtRestante = txtRestante.slice(0, start) + ' '.repeat(exame.length) + txtRestante.slice(start + exame.length);
    }
  }

  if (achados.length === 0) return null;

  const chaves = achados.map(a => a.chave);
  const tem = (c) => chaves.includes(c);

  const removidos = new Set();
  const extras = [];

  const VARIANTES_GLICEMIA = ['glicemia de jejum', 'glicemia pos-prandial', 'glicemia pos-sobrecarga com glicose',
    'glicemia casual', 'glicose de jejum', 'glicose pos-prandial', 'glicose casual', 'glicemia', 'glicose'];
  const temHemograma = tem('hemograma');
  const glicemiaAchada = VARIANTES_GLICEMIA.find(tem);
  const temHba1c = tem('hba1c');

  // Eritrograma é um componente do Hemograma Completo — se os dois aparecem juntos no texto,
  // é a descrição do que compõe o hemograma (ex: "hemograma... eritrograma, leucograma, plaquetas"),
  // não um pedido separado. Não cobra os dois.
  if (temHemograma && tem('eritrograma')) {
    removidos.add('eritrograma');
  }

  // Hemograma e HMG (sigla) são o mesmo exame — não cobra os dois se aparecerem juntos
  if (temHemograma && tem('hmg')) {
    removidos.add('hmg');
  }

  // Perfil Lipídico e Lipidograma são o mesmo exame (sinônimos) — não cobra os dois se aparecerem juntos
  if (tem('lipidograma') && (tem('perfil lipidico') || tem('perfil lipídico'))) {
    removidos.add('perfil lipidico');
    removidos.add('perfil lipídico');
  }

  // Antiestreptolisina O e ASLO são o mesmo exame (sigla) — não cobra os dois se aparecerem juntos
  if (tem('antiestreptolisina o') && tem('aslo')) {
    removidos.add('aslo');
  }

  // Tempo/Atividade da Protrombina e TAP são o mesmo exame (sigla) — não cobra os dois se aparecerem juntos
  if ((tem('tempo de protrombina') || tem('tempo e atividade da protrombina')) && tem('tap')) {
    removidos.add('tap');
  }

  if (temHemograma && glicemiaAchada && achados.length === 2) {
    removidos.add('hemograma'); removidos.add(glicemiaAchada);
    extras.push({ nome: 'hemograma + glicemia (combo)', valor: 55 });
  } else if (temHemograma && achados.length === 1) {
    removidos.add('hemograma');
    extras.push({ nome: 'hemograma (sozinho)', valor: 30 });
  } else if (glicemiaAchada && achados.length === 1) {
    removidos.add(glicemiaAchada);
    extras.push({ nome: 'glicemia (sozinho)', valor: 25 });
  }

  if (temHba1c && achados.length === 1) {
    removidos.add('hba1c');
    extras.push({ nome: 'hba1c (sozinho)', valor: 32 });
  }

  const CHAVES_COLESTEROL = ['colesterol', 'colesterol total'];
  const CHAVES_HDL = ['hdl', 'colesterol hdl'];
  const CHAVES_LDL = ['ldl', 'colesterol ldl'];
  const CHAVES_VLDL = ['vldl', 'colesterol vldl'];
  const CHAVES_TRIG = ['triglicerides', 'triglicerídeos', 'triglicerideos'];
  const CHAVES_LIPIDO_TODAS = CHAVES_COLESTEROL.concat(CHAVES_HDL, CHAVES_LDL, CHAVES_VLDL, CHAVES_TRIG);

  const temLipidoCompleto = CHAVES_HDL.some(tem) && CHAVES_LDL.some(tem) &&
    (CHAVES_VLDL.some(tem) || CHAVES_TRIG.some(tem));
  if (temLipidoCompleto) {
    const lipidosAchados = achados.filter(a => CHAVES_LIPIDO_TODAS.includes(a.chave));
    lipidosAchados.forEach(a => removidos.add(a.chave));
    const soLipido = achados.length === lipidosAchados.length;
    const somaComponentes = lipidosAchados.reduce((s, a) => s + a.valor, 0);
    extras.push({
      nome: 'lipidograma' + (soLipido ? ' (isolado)' : ''),
      valor: soLipido ? somaComponentes : TABELA_PRECOS['lipidograma']
    });
  }

  if (!(tem('grupo sanguineo e fator rh') || tem('grupo sanguíneo e fator rh')) &&
      (tem('grupo sanguineo') || tem('grupo sanguíneo')) && tem('fator rh')) {
    removidos.add('grupo sanguineo'); removidos.add('grupo sanguíneo'); removidos.add('fator rh');
    extras.push({ nome: 'grupo sanguineo e fator rh', valor: 20 });
  }

  if (tem('toxoplasmose') && /igm/.test(txt) && /igg/.test(txt)) {
    removidos.add('toxoplasmose');
    extras.push({ nome: 'toxoplasmose (igm+igg)', valor: 50 });
  }

  // Testosterona pedida sem especificar livre/total -> cobra as duas (convenção da clínica)
  // Se além da menção genérica também aparecer "livre" ou "total" específico em outra linha da
  // mesma receita, não cobra de novo — já está incluído no combo.
  if (tem('testosterona')) {
    removidos.add('testosterona');
    removidos.add('testosterona total');
    removidos.add('testosterona livre');
    extras.push({ nome: 'testosterona total + livre (combo)', valor: 23.5 + 29.5 });
  }

  // Antibiograma + cultura de bactérias (fraseado típico do SUS, sem a palavra "urocultura",
  // e às vezes truncado como "ANTIBIOGR" em guias de convênio) -> combo
  if ((tem('antibiograma') || /\bantibiogr\w*/.test(txt)) && /cultura/.test(txt) && !tem('urocultura + antibiograma') &&
      !tem('urocultura com antibiograma') && !tem('urocultura antibiograma')) {
    removidos.add('antibiograma');
    extras.push({ nome: 'urocultura + antibiograma (combo)', valor: 32 });
  }

  const achadosFinais = achados.filter(a => !removidos.has(a.chave));
  let total = achadosFinais.reduce((s, a) => s + a.valor, 0);
  total += extras.reduce((s, e) => s + e.valor, 0);

  const encontrados = achadosFinais.map(a => a.chave)
    .concat(extras.map(e => e.nome));

  // Sexagem Fetal e Beta-HCG: preço fixo, sem desconto no pix (mesmo valor nas duas formas de pagamento)
  const SEM_DESCONTO_PIX = ['sexagem fetal', 'beta-hcg', 'beta hcg', 'bhcg'];
  const valorSemDesconto = achadosFinais
    .filter(a => SEM_DESCONTO_PIX.includes(a.chave))
    .reduce((s, a) => s + a.valor, 0);
  const valorComDesconto = total - valorSemDesconto;

  const cartao = total;
  const pix = Math.round((valorComDesconto * 0.90 + valorSemDesconto) * 100) / 100;

  return { total, cartao, pix, encontrados };
}

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
    // Tabela de referência de dias da semana — dinâmica, cobre os próximos 45 dias a partir de hoje
    const tabelaDias = [];
    for (let i = 0; i < 45; i++) {
      const d = new Date(nowBR);
      d.setDate(d.getDate() + i);
      const dd = String(d.getDate()).padStart(2,'0');
      const mm = String(d.getMonth()+1).padStart(2,'0');
      tabelaDias.push(dd + '/' + mm + '=' + diaDaSemana(d.getDate(), d.getMonth()+1).slice(0,3));
    }
    const refDiasSemana = tabelaDias.join(', ');

    // Agenda com suporte a múltiplas datas por especialidade — filtra automaticamente as que já passaram
    const AGENDA_ESPECIALIDADES = {
      'Psiquiatria': { horario: '13h30–17h00', periodo: 'SOMENTE TARDE', datas: [{dia:7,mes:7},{dia:21,mes:7},{dia:7,mes:8},{dia:21,mes:8}] },
      'Otorrinolaringologia': { horario: '13h30–17h00', periodo: 'SOMENTE TARDE', datas: [{dia:27,mes:7}] },
      'Endocrinologia': { horario: '14h00–17h00', periodo: 'SOMENTE TARDE', datas: [{dia:4,mes:8}] },
      'Ginecologia': { horario: '13h00–16h00', periodo: 'SOMENTE TARDE', datas: [{dia:31,mes:7},{dia:14,mes:8},{dia:28,mes:8}] },
    };
    function formatarListaDatas(lista) {
      if (lista.length === 1) return lista[0];
      if (lista.length === 2) return lista.join(' e ');
      return lista.slice(0, -1).join(', ') + ' e ' + lista[lista.length - 1];
    }
    function formatarLinhaAgenda(nome, cfg) {
      const futuras = cfg.datas.filter(function (d) { return dataFutura(d.dia, d.mes); })
        .map(function (d) { return String(d.dia).padStart(2, '0') + '/' + String(d.mes).padStart(2, '0'); });
      if (futuras.length === 0) return '• ' + nome + ': sem agenda disponível no momento';
      return '• ' + nome + ': ' + formatarListaDatas(futuras) + ' das ' + cfg.horario + ' — ' + cfg.periodo;
    }

    const agendaFiltrada = [
      formatarLinhaAgenda('Psiquiatria', AGENDA_ESPECIALIDADES['Psiquiatria']),
      formatarLinhaAgenda('Otorrinolaringologia', AGENDA_ESPECIALIDADES['Otorrinolaringologia']),
      formatarLinhaAgenda('Endocrinologia', AGENDA_ESPECIALIDADES['Endocrinologia']),
      formatarLinhaAgenda('Ginecologia', AGENDA_ESPECIALIDADES['Ginecologia']),
      (function() {
        const AGENDA_CLINICO = [
          { dia: 20, mes: 7, manha: '09h00–10h30', tarde: '16h00–17h15' },
          { dia: 23, mes: 7, manha: '08h00–11h30', tarde: '14h00–17h00' },
        ];
        const disponiveis = AGENDA_CLINICO
          .filter(function (d) { return dataFutura(d.dia, d.mes); })
          .map(function (d) {
            const dd = String(d.dia).padStart(2, '0') + '/' + String(d.mes).padStart(2, '0');
            const periodos = 'manhã ' + d.manha + (d.tarde ? ' e tarde ' + d.tarde : ' (sem tarde)');
            return dd + ' (' + periodos + ')';
          });
        return '• Clínico Geral/Pediatria (datas específicas): ' + (disponiveis.length ? disponiveis.join(' | ') : 'sem agenda no momento');
      })(),
      (function() {
        const horariosUSG = { 2: 'Terça: 14h00–17h30', 5: 'Sexta: 07h00–09h45 e 17h00–18h00' };
        const disponiveisUSG = [];
        for (let i = 0; i <= 10; i++) {
          const d = new Date(nowBR);
          d.setDate(d.getDate() + i);
          const dow = d.getDay();
          if (horariosUSG[dow]) {
            const dd = String(d.getDate()).padStart(2,'0');
            const mm = String(d.getMonth()+1).padStart(2,'0');
            disponiveisUSG.push(dd + '/' + mm + ' (' + horariosUSG[dow] + ')');
          }
          if (disponiveisUSG.length >= 2) break;
        }
        return '• Ultrassom (próximos dias): ' + (disponiveisUSG.length ? disponiveisUSG.join(' | ') : 'sem agenda no momento');
      })(),
      (function() {
        function inicioSemana(data) {
          const d = new Date(data);
          const dow = d.getDay();
          const diffParaSegunda = dow === 0 ? -6 : 1 - dow;
          d.setDate(d.getDate() + diffParaSegunda);
          d.setHours(0, 0, 0, 0);
          return d;
        }
        const ANCORA_SEMANA_A = new Date(2026, 5, 29); // 29/06/2026, segunda, início da Semana A
        function tipoSemana(data) {
          const segundaAtual = inicioSemana(data);
          const diffDias = Math.round((segundaAtual - ANCORA_SEMANA_A) / (1000 * 60 * 60 * 24));
          const semanasPassadas = diffDias / 7;
          return (Math.round(semanasPassadas) % 2 === 0) ? 'A' : 'B';
        }
        const diasSemanaA = [1, 3, 5]; // segunda, quarta, sexta
        const diasSemanaB = [2, 4]; // terça, quinta
        const disponiveisColeta = [];
        for (let i = 0; i <= 14; i++) {
          const d = new Date(nowBR);
          d.setDate(d.getDate() + i);
          const tipo = tipoSemana(d);
          const diasValidos = tipo === 'A' ? diasSemanaA : diasSemanaB;
          if (diasValidos.includes(d.getDay())) {
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            disponiveisColeta.push(dd + '/' + mm);
          }
          if (disponiveisColeta.length >= 4) break;
        }
        return '• Coleta Laboratorial (07h00–09h45, próximas datas): ' + (disponiveisColeta.length ? disponiveisColeta.join(' | ') : 'sem agenda no momento');
      })(),
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

    let systemDinamico = '\n\nAGENDA ATUAL (somente datas futuras):\n' + agendaFiltrada
      + '\n\nDATA/HORA ATUAL (Brasília): ' + agora + ' — Hoje é ' + diaSemana + ', ' + dataHoje
      + '\n\nTABELA DE DIAS DA SEMANA JUNHO/2026 (use SEMPRE esta tabela para informar dia da semana de qualquer data — NUNCA calcule de memória): ' + refDiasSemana
      + '\n\nREGRA OBRIGATÓRIA DE SAUDAÇÃO: Agora são ' + hora + 'h em Brasília. Se a resposta começar com saudação, USE EXATAMENTE "' + saudacao + '". NUNCA use "Boa noite" se a hora atual for ' + hora + 'h. Se for encerrar a conversa, use "' + despedida + '".';

    if (esp) {
      systemDinamico += '\n\nLEMBRETE CRÍTICO: O paciente JÁ informou que quer ' + esp + '. NÃO pergunte especialidade. Prossiga para o próximo dado necessário.';
    }

    // Prompt caching: SYSTEM_PROMPT é enorme e idêntico em toda chamada — cacheado, custa só 10% do preço normal.
    // A parte dinâmica (agenda/hora/lembretes) muda a cada mensagem, então fica de fora do cache.
    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-5', max_tokens: 600,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: systemDinamico }
        ],
        messages: hist },
      { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 30000 }
    );
    const blocoTexto = (r.data.content || []).find(function(b) { return b.type === 'text'; });
    if (!blocoTexto || !blocoTexto.text) throw new Error('Resposta da IA sem bloco de texto: ' + JSON.stringify(r.data.content));
    return blocoTexto.text;
  } catch(e) {
    console.error('ERRO chamarIA - status:', e.response ? e.response.status : '?', '- corpo:', e.response ? JSON.stringify(e.response.data) : e.message);
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
    // Redimensiona a imagem antes de enviar — fotos de celular costumam vir em resolução muito
    // maior do que o necessário pra ler texto, e o custo da API de visão escala com o tamanho
    // da imagem. 1568px no lado maior é o suficiente para leitura nítida e é o tamanho ótimo
    // recomendado pela própria Anthropic (imagens maiores não melhoram a leitura, só custam mais).
    const imagemRedimensionada = await sharp(Buffer.from(imgResp.data))
      .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const base64 = imagemRedimensionada.toString('base64');
    const mediaType = 'image/jpeg';
    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-5', max_tokens: 1200, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'Analise esta imagem. Se for receita/pedido médico: extraia nome do médico, CRM e a lista de exames solicitados. REGRA CRÍTICA: liste CADA exame individualmente, numerado, com o nome EXATO/LITERAL como está escrito ou impresso no documento (ex: "Dosagem de Creatinina", "Transaminase Glutâmico-Oxalacética (TGO)", "Hemograma Completo"). NUNCA agrupe, resuma ou generalize exames em categorias como "função renal", "função hepática", "perfil lipídico" ou "entre outros" — mesmo que a lista seja longa (10, 20, 30+ itens), liste TODOS sem exceção e sem abreviar a lista. ATENÇÃO A FORMULÁRIOS COM CAIXINHAS/CHECKBOXES: se o documento for um formulário de múltipla escolha com quadradinhos (□) ao lado de cada exame, observe CUIDADOSAMENTE quais quadradinhos estão MARCADOS (preenchidos, com X, com ✓, ou rabiscados) e liste APENAS esses — ignore os desmarcados. Esses formulários costumam ter dezenas de opções organizadas em categorias (Hematologia, Bioquímica, Sorologia, Hormônios, etc.) mas só uma fração é marcada; releia a imagem com atenção antes de responder, verificando cada seção do formulário, pois é comum haver itens marcados em categorias diferentes (ex: alguns em Bioquímica, outros em Hormônios, outros em Urinálise) — não pare na primeira seção. Se for resultado de exame (não pedido): identifique o tipo. Responda simples e direto, sem markdown.' }
      ]}]},
      { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 30000 }
    );
    const blocoTexto = (r.data.content || []).find(function(b) { return b.type === 'text'; });
    return blocoTexto ? blocoTexto.text : null;
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
const CACHE_MAX = 12; // máximo de mensagens por número (reduzido para economizar tokens — dados essenciais como nome/nascimento/especialidade ficam salvos à parte, não dependem do histórico)

function cacheAdicionarMensagem(num, role, content) {
  if (!historicoCache[num]) historicoCache[num] = [];
  historicoCache[num].push({ role: role, content: content });
  if (historicoCache[num].length > CACHE_MAX) historicoCache[num] = historicoCache[num].slice(-CACHE_MAX);
}

async function buscarHistoricoComCache(num) {
  // Busca do banco
  const dbHist = await db.buscarHistorico(num, 12);
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

// Tabela de serviços NÃO-laboratoriais (ultrassom, consultas, procedimentos) — preço fixo,
// usada só para detectar e registrar no funil de vendas (o preço narrado ao paciente já vem do prompt)
const TABELA_SERVICOS = {
  'abdome inferior com doppler': 160, 'abdome inferior': 70,
  'abdome superior com doppler': 160, 'abdome superior': 80,
  'usg axilas': 70, 'axilas': 70,
  'abdome total com doppler': 350, 'abdome total': 100,
  'usg articulacao': 80,
  'bolsa escrotal com doppler': 150, 'bolsa escrotal': 80,
  'usg mamas': 90,
  'morfologica 1 trimestre': 230, 'morfologica 1º trimestre': 230,
  'morfologica 2 trimestre': 280, 'morfologica 2º trimestre': 280,
  'obstetrica com doppler': 280, 'obstetrica endovaginal': 100,
  'obstetrica gestacao multipla': 180, 'obstetrica': 100,
  'usg partes moles': 70,
  'usg prostata': 90,
  'quadril pediatrico': 80, 'quadril adulto': 80,
  'tireoide com doppler': 150, 'usg tireoide': 90,
  'transvaginal com doppler': 160, 'usg transvaginal': 90,
  'vias urinarias': 80,
  'usg transfontanela': 130,
  'usg pelvica': 80,
  'usg punho': 80,
  'parede abdominal': 80,
  'parotidas com doppler': 160, 'usg parotidas': 70,
  'usg orelha': 70,
  'usg cervical': 80,
  'usg ombro': 90,
  'usg inguinal': 80,
  'doppler isolado': 140, 'doppler carotidas': 150,
  'consulta clinico geral': 80, 'clinico geral': 80,
  'consulta ginecologia': 120, 'ginecologia': 120, 'ginecologista': 120,
  'consulta endocrinologia': 120, 'endocrinologia': 120, 'endocrinologista': 120,
  'consulta psiquiatria': 120, 'psiquiatria': 120, 'psiquiatra': 120,
  'consulta pediatria': 100, 'pediatria': 100, 'pediatra': 100,
  'consulta otorrino': 140, 'otorrino': 140, 'otorrinolaringologista': 140, 'otorrinolaringologia': 140,
  'limpeza de ouvido': 50,
  'inserir diu': 400, 'diu inserir': 400,
  'retirar diu': 300, 'diu retirar': 300,
  'prevencao': 80,
  'retirada de pontos': 50,
  'holter': 150, 'holter 24h': 150,
  'mapa': 140, 'mapa 24h': 140,
  'eletrocardiograma': 50,
};

function calcularServico(textoExames) {
  const txt = textoExames.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let txtRestante = txt;
  const encontrados = [];
  const chavesOrdenadas = Object.keys(TABELA_SERVICOS).sort((a, b) => b.length - a.length);
  for (const chave of chavesOrdenadas) {
    const re = new RegExp('(?:^|[^a-z0-9])(' + escapeRegex(chave) + ')(?:$|[^a-z0-9])');
    const m = re.exec(txtRestante);
    if (m) {
      encontrados.push({ item: chave, valor: TABELA_SERVICOS[chave] });
      const start = m.index + m[0].indexOf(m[1]);
      txtRestante = txtRestante.slice(0, start) + ' '.repeat(chave.length) + txtRestante.slice(start + chave.length);
    }
  }
  return encontrados.length ? encontrados[0] : null; // registra só o primeiro serviço mencionado
}

// CRM — Funil de vendas: registra cada orçamento laboratorial enviado
async function registrarLeadOrcamento(num, nome, orcamento, origem) {
  try {
    // Evita duplicar lead se já existe um recente (últimas 2h) pra esse mesmo telefone ainda
    // em "orcamento_enviado" — atualiza o existente em vez de criar um novo a cada mensagem
    const duasHorasAtras = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: existente } = await db.supabase.from('leads_orcamento')
      .select('id')
      .eq('telefone', num)
      .eq('status', 'orcamento_enviado')
      .gte('criado_em', duasHorasAtras)
      .order('criado_em', { ascending: false })
      .limit(1);

    if (existente && existente.length > 0) {
      await db.supabase.from('leads_orcamento')
        .update({
          nome: nome || null,
          valor_cartao: orcamento.cartao,
          valor_pix: orcamento.pix,
          exames: JSON.stringify(orcamento.encontrados || []),
          atualizado_em: new Date().toISOString(),
        })
        .eq('id', existente[0].id);
      return;
    }

    await db.supabase.from('leads_orcamento').insert({
      telefone: num,
      nome: nome || null,
      valor_cartao: orcamento.cartao,
      valor_pix: orcamento.pix,
      exames: JSON.stringify(orcamento.encontrados || []),
      status: 'orcamento_enviado',
      origem: origem,
    });
  } catch(e) { console.error('ERRO registrarLeadOrcamento:', e.message); }
}

// CRM — Funil de vendas: marca leads recentes desse telefone como convertidos ao agendar
async function marcarLeadAgendado(num) {
  try {
    await db.supabase.from('leads_orcamento')
      .update({ status: 'agendado', atualizado_em: new Date().toISOString() })
      .eq('telefone', num)
      .eq('status', 'orcamento_enviado');
  } catch(e) { console.error('ERRO marcarLeadAgendado:', e.message); }
}

// AGENTE DE VENDAS — Follow-up automático de leads que não converteram
// Regras de segurança (pra não repetir a suspensão do WhatsApp de antes):
// - só contata quem está "orcamento_enviado" há mais de 24h (nunca 10 minutos)
// - manda no máximo 4 mensagens por execução (roda a cada 1h = no máx ~4/hora)
// - espera real entre cada envio (não manda tudo de uma vez)
// - nunca contata o mesmo lead duas vezes (marca followup_enviado_em)
// - respeita a lista de números ignorados
const FOLLOWUP_MAX_POR_EXECUCAO = 4;
const FOLLOWUP_DELAY_ENTRE_ENVIOS_MS = 14 * 60 * 1000; // ~14 min entre cada — espalha as 4 mensagens ao longo da hora inteira, em vez de concentrar tudo nos primeiros minutos
const FOLLOWUP_ESPERA_MINIMA_HORAS = 24;

async function executarFollowUpVendas(forcar) {
  try {
    // Checa no banco (não na memória) se já passou tempo suficiente desde a última execução —
    // isso sobrevive a reinícios do servidor (Render pode dormir/reiniciar o processo).
    const { data: statusRows } = await db.supabase.from('agente_vendas_status').select('*').eq('id', 1).limit(1);
    const status = statusRows && statusRows[0];
    const agora = new Date();
    if (!forcar && status && status.ultima_execucao) {
      const minutosDesdeUltima = (agora - new Date(status.ultima_execucao)) / (60 * 1000);
      if (minutosDesdeUltima < 55) return; // ainda não passou quase 1h desde a última execução real
    }
    await db.supabase.from('agente_vendas_status').upsert({ id: 1, ultima_execucao: agora.toISOString() });

    const limiteData = new Date(Date.now() - FOLLOWUP_ESPERA_MINIMA_HORAS * 60 * 60 * 1000).toISOString();
    const { data: leads } = await db.supabase.from('leads_orcamento')
      .select('*')
      .eq('status', 'orcamento_enviado')
      .is('followup_enviado_em', null)
      .lt('criado_em', limiteData)
      .order('criado_em', { ascending: true })
      .limit(FOLLOWUP_MAX_POR_EXECUCAO);

    if (!leads || leads.length === 0) return;
    console.log('FOLLOWUP_VENDAS: ' + leads.length + ' lead(s) para contatar nesta execução');

    for (const lead of leads) {
      if (numeroEstaIgnorado(lead.telefone)) continue;
      if (await emAtendimentoHumano(lead.telefone)) continue; // não interrompe atendimento humano em andamento

      const saudacaoNome = lead.nome ? lead.nome.split(' ')[0] : '';
      const msg = (saudacaoNome ? 'Oi, ' + saudacaoNome + '! 😊' : 'Oi! 😊') +
        ' Vi que você pediu um orçamento aqui no Centro Médico América e a gente não chegou a continuar. ' +
        'Ainda tem interesse? Fico à disposição se quiser agendar ou tirar alguma dúvida, sem pressa nenhuma! 💙';

      await enviar(lead.telefone, msg);
      await db.supabase.from('leads_orcamento')
        .update({ followup_enviado_em: new Date().toISOString() })
        .eq('id', lead.id);
      console.log('FOLLOWUP_VENDAS: mensagem enviada para ' + lead.telefone);

      await new Promise(function(r) { setTimeout(r, FOLLOWUP_DELAY_ENTRE_ENVIOS_MS); });
    }
  } catch(e) {
    console.error('ERRO executarFollowUpVendas:', e.message);
  }
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
  if (esp.includes('otorrino')) return 'tarde';
  if (esp.includes('ginecolog')) return 'tarde';
  return null;
}
function extrairDadosMensagem(texto) {
  const dados = {};
  // Detecta data de nascimento em vários formatos: DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA,
  // DD MM AAAA (com espaço), ou DDMMAAAA (colado, sem separador nenhum)
  const nascMatch = texto.match(/\b(\d{1,2})[\/\-\.\s]?(\d{1,2})[\/\-\.\s]?(\d{4})\b/);
  if (nascMatch) {
    const dia = parseInt(nascMatch[1], 10);
    const mes = parseInt(nascMatch[2], 10);
    const ano = parseInt(nascMatch[3], 10);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12 && ano >= 1900 && ano <= 2026) {
      dados.nascimento = String(dia).padStart(2, '0') + '/' + String(mes).padStart(2, '0') + '/' + ano;
    }
  }
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

  // Debounce real: espera até NÃO chegar mensagem nova por 2.5s seguidos
  // (evita responder duas vezes quando o paciente manda mensagens com intervalo maior que o antigo timer fixo)
  let tamanhoAnterior = -1;
  while (filas[num] && filas[num].msgs.length !== tamanhoAnterior) {
    tamanhoAnterior = filas[num].msgs.length;
    await new Promise(function(r) { setTimeout(r, 2500); });
  }
  if (!filas[num] || filas[num].msgs.length === 0) {
    if (filas[num]) filas[num].rodando = false;
    return;
  }

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
        console.log('LEITURA_IMAGEM [' + num + ']: ' + leitura);
        await db.salvarMensagem(num, 'user', '[imagem enviada]');
        let hist = await db.buscarHistorico(num, 12);
        hist = hist.filter(function(m){return m.content && m.content.trim();});
        // Calcula orçamento no código usando a leitura da imagem
        const orcamentoImg = calcularOrcamento(leitura);
        let instrucaoOrcamento = '';
        if (orcamentoImg && orcamentoImg.total > 0) {
          instrucaoOrcamento = '\n\nORÇAMENTO CALCULADO PELO SISTEMA — USE ESTES VALORES EXATOS: 💳 Cartão: R$' + orcamentoImg.cartao.toFixed(2) + ' | 💵 Pix/Dinheiro: R$' + orcamentoImg.pix.toFixed(2) + '. NÃO recalcule. NÃO modifique esses valores.';
          console.log('ORÇAMENTO IMAGEM [' + num + ']: base=R$' + orcamentoImg.total + ' cartão=R$' + orcamentoImg.cartao.toFixed(2) + ' — EXAMES ENCONTRADOS: ' + JSON.stringify(orcamentoImg.encontrados));
          await registrarLeadOrcamento(num, null, orcamentoImg, 'whatsapp');
        } else {
          const servicoImg = calcularServico(leitura);
          if (servicoImg) {
            console.log('SERVIÇO IMAGEM [' + num + ']: ' + servicoImg.item + ' = R$' + servicoImg.valor);
            await registrarLeadOrcamento(num, null, { cartao: servicoImg.valor, pix: servicoImg.valor, encontrados: [servicoImg.item] }, 'whatsapp');
          }
        }
        hist.push({ role: 'user', content: 'O paciente enviou uma imagem/receita médica. Análise da imagem: ' + leitura + instrucaoOrcamento + '\n\nInstruções:\n1. Confirme o nome do paciente e LISTE cada exame identificado individualmente pelo nome, NUMERADO (1. 2. 3. ...) para o paciente ver de forma clara quantos exames são (NUNCA agrupe em categorias como "função renal", "perfil hormonal" etc.)\n2. Informe os valores calculados acima (use exatamente esses valores)\n3. Avise de forma natural que é uma prévia e que a secretaria vai confirmar o valor final e os exames identificados\n4. Se houver Tomografia (TC/TAC) ou Ressonância (RM/RNM) na lista, avise CLARAMENTE que a clínica não realiza esse exame específico e que o paciente precisa procurar outro local — não diga apenas "será tratado à parte"\n5. Convide para agendar os exames que a clínica faz\nSe algum exame não tiver valor calculado, mencione que entrará em contato para complementar.' });
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

    // Calcula orçamento no código se a mensagem contém exames
    const orcamento = (!MODO_TESTE_LAB || NUMEROS_TESTE_LAB.includes(num)) ? calcularOrcamento(txtCompleto) : null;
    if (orcamento && orcamento.total > 0) {
      const infoOrcamento = '[ORÇAMENTO CALCULADO PELO SISTEMA — USE ESTES VALORES EXATOS: ' +
        '💳 Cartão: R$' + orcamento.cartao.toFixed(2) + ' | ' +
        '💵 Pix/Dinheiro: R$' + orcamento.pix.toFixed(2) + '. ' +
        'NÃO recalcule. Use estes valores exatos na resposta.]';
      hist.push({ role: 'user', content: infoOrcamento });
      console.log('ORÇAMENTO [' + num + ']: base=R$' + orcamento.total + ' cartão=R$' + orcamento.cartao + ' pix=R$' + orcamento.pix);
      await registrarLeadOrcamento(num, null, orcamento, 'whatsapp');
    } else {
      // Não é exame de laboratório — verifica se é ultrassom/consulta/procedimento, para o funil de vendas
      const servico = calcularServico(txtCompleto);
      if (servico) {
        console.log('SERVIÇO [' + num + ']: ' + servico.item + ' = R$' + servico.valor);
        await registrarLeadOrcamento(num, null, { cartao: servico.valor, pix: servico.valor, encontrados: [servico.item] }, 'whatsapp');
      }
    }

    // Detecta se o paciente está recusando/adiando o agendamento nesta mensagem
    const respostaSeca = txtCompleto.trim().toLowerCase().replace(/[.!?]+$/, '');
    const recusouAgendar = /n[ãa]o quero (agendar|marcar)|n[ãa]o vou agendar|agora n[ãa]o|n[ãa]o agora|depois eu (agendo|marco|confirmo)|vou pensar|s[óo] confirmar depois|talvez depois|ainda n[ãa]o/i.test(txtCompleto)
      || ['nao', 'não', 'nops', 'nao quero', 'não quero'].includes(respostaSeca);

    if (recusouAgendar) {
      // Limpa o "empurrão" de nome/nascimento para não insistir nas próximas mensagens também
      await atualizarEstado(num, { periodo: null, dataEscolhida: null });
      hist.push({ role: 'user', content: '[INSTRUÇÃO: O paciente disse que não quer agendar agora. Responda de forma acolhedora, SEM insistir, SEM pedir nome ou data de nascimento. Apenas avise que fica à disposição quando ele quiser agendar.]' });
      console.log('RECUSOU_AGENDAR [' + num + ']');
    } else {

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
      await marcarLeadAgendado(num);
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
  if (numeroEstaIgnorado(num)) return;
  if (MODO_TESTE && !NUMEROS_TESTE_LAB.includes(num)) return;

  // Deduplica por messageId
  const msgId = b.messageId || '';
  if (msgId && msgProcessadas.has(msgId)) { console.log('DUP [' + msgId + ']'); return; }
  if (msgId) { msgProcessadas.add(msgId); setTimeout(function(){msgProcessadas.delete(msgId);}, 10*60*1000); }

  // Secretaria humana digitou
  if (b.fromMe && !b.fromApi) {
    const t = (b.text && b.text.message) || '';
    if (t.trim() !== '#cma') {
      ativarHumano(num, 10).then(function(){ console.log('SECRETARIA [' + num + ']: CMA pausada 10min'); });
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
  } catch(e) {
    res.json({
      erro: e.message,
      status: e.response ? e.response.status : null,
      corpo_resposta_zapi: e.response ? e.response.data : null,
      client_token_configurado: !!process.env.ZAPI_CLIENT_TOKEN,
      client_token_tamanho: process.env.ZAPI_CLIENT_TOKEN ? process.env.ZAPI_CLIENT_TOKEN.length : 0
    });
  }
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
    let hist = await db.buscarHistorico(tel, 12);
    if (!hist.length || hist[hist.length-1].role !== 'user') hist.push({ role: 'user', content: msg });

    // Calcula orçamento no código (mesmo comportamento do fluxo de WhatsApp) — NUNCA deixa a IA calcular de cabeça
    const orcamentoChat = calcularOrcamento(msg);
    if (orcamentoChat && orcamentoChat.total > 0) {
      const infoOrcamentoChat = '[ORÇAMENTO CALCULADO PELO SISTEMA — USE ESTES VALORES EXATOS: ' +
        '💳 Cartão: R$' + orcamentoChat.cartao.toFixed(2) + ' | ' +
        '💵 Pix/Dinheiro: R$' + orcamentoChat.pix.toFixed(2) + '. ' +
        'NÃO recalcule. Use estes valores exatos na resposta.]';
      hist.push({ role: 'user', content: infoOrcamentoChat });
      console.log('ORÇAMENTO CHAT [' + tel + ']: base=R$' + orcamentoChat.total + ' cartão=R$' + orcamentoChat.cartao + ' pix=R$' + orcamentoChat.pix);
      await registrarLeadOrcamento(tel, null, orcamentoChat, 'chat');
    } else {
      const servicoChat = calcularServico(msg);
      if (servicoChat) {
        console.log('SERVIÇO CHAT [' + tel + ']: ' + servicoChat.item + ' = R$' + servicoChat.valor);
        await registrarLeadOrcamento(tel, null, { cartao: servicoChat.valor, pix: servicoChat.valor, encontrados: [servicoChat.item] }, 'chat');
      }
    }

    const resp = await chamarIA(hist);
    const ag = extrairAgendamento(resp);
    if (ag) {
      await db.salvarAgendamento({ nome_paciente: ag.nome, data_nascimento: ag.nascimento||null, telefone: tel, especialidade: ag.especialidade, convenio: 'particular', periodo: ag.periodo, origem: 'chat' });
      await marcarLeadAgendado(tel);
    }
    const final = limpar(resp);
    await db.salvarMensagem(tel, 'assistant', final);
    res.json({ resposta: final, agendamento: ag||null });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/funil/followup', async function(req, res) {
  try {
    await executarFollowUpVendas(!!req.body.forcar);
    res.json({ ok: true, mensagem: 'Follow-up executado (respeitando o limite de ' + FOLLOWUP_MAX_POR_EXECUCAO + ' mensagens por execução).' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/funil/:id', async function(req, res) {
  try {
    await db.supabase.from('leads_orcamento')
      .update({ status: req.body.status, atualizado_em: new Date().toISOString() })
      .eq('id', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/funil', async function(req, res) {
  try {
    // Marca automaticamente como "perdido" quem recebeu orçamento há mais de 7 dias e não agendou
    const seteDiasAtras = new Date(Date.now() - 7*24*60*60*1000).toISOString();
    await db.supabase.from('leads_orcamento')
      .update({ status: 'perdido', atualizado_em: new Date().toISOString() })
      .eq('status', 'orcamento_enviado')
      .lt('criado_em', seteDiasAtras);

    const r = await db.supabase.from('leads_orcamento').select('*').order('criado_em', { ascending: false }).limit(200);
    const leads = r.data || [];
    const resumo = {
      orcamento_enviado: leads.filter(function(l){ return l.status === 'orcamento_enviado'; }).length,
      agendado: leads.filter(function(l){ return l.status === 'agendado'; }).length,
      perdido: leads.filter(function(l){ return l.status === 'perdido'; }).length,
      total: leads.length,
    };
    res.json({ resumo: resumo, leads: leads });
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
app.listen(PORT, function() {
  console.log('América — CMA v3 | Porta: ' + PORT + ' | Online');
  // Agente de vendas: roda a cada 1 hora, verifica se tem leads pra contatar (respeitando os limites de segurança)
  setInterval(executarFollowUpVendas, 10 * 60 * 1000);
  executarFollowUpVendas(); // já checa uma vez assim que o servidor sobe (não espera 10 min pro primeiro check)
});
