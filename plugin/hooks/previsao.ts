export type Amostra = { t: number; p: number }

export type Janela = { kind: string; resetsAt: number; pts: Amostra[] }

// Horas (início de cada hora, em ms) em que houve uso do Claude Code, e quando o registro começou
export type Perfil = { desde: number; ultima: number; horas: number[] }

export type OrigemRitmo = 'recente' | 'janela' | 'anterior'

export type Previsao = {
  kind: string
  pct: number
  resetsAt: number
  // Pontos percentuais por hora de uso, não por hora de relógio
  ritmoPorHora: number | null
  origem: OrigemRitmo | null
  // Horas de uso esperadas daqui até a renovação, pelo horário aprendido
  horasRestantes: number
  esgotaEm: number | null
  pctNaRenovacao: number | null
}

const MINUTO = 60_000
const HORA = 60 * MINUTO
const DIA = 24 * HORA
const SEMANA = 7 * DIA
const RETENCAO = 35 * DIA

// Além de five_hour e seven_day, aceita limites semanais por modelo (seven_day_<modelo>), se o Claude Code passar a enviá-los
export function duracaoDe(kind: string): number | undefined {
  if (kind.startsWith('five_hour')) return 5 * HORA
  if (kind.startsWith('seven_day')) return SEMANA
  return undefined
}

// Abaixo disso de uso medido na janela, o ritmo ainda não é confiável
function minimoHorasUso(duracao: number): number {
  return duracao === SEMANA ? 1 : 0.25
}

// Na janela de 5 horas vale o ritmo dos últimos 45 minutos, que reage quando o trabalho acelera ou para
const RECENTE_MS = 45 * MINUTO
const SPAN_MINIMO_MS = 10 * MINUTO
// Uso nos últimos 30 minutos: a hora corrente conta como hora de uso
const ATIVO_MS = 30 * MINUTO

// Previsão acima disso na renovação, mesmo sem acabar, já merece atenção
const PERTO_DO_LIMITE = 90
// Previsão abaixo disso na renovação: sobra limite, dá para usar mais
const FOLGA = 60

// Português do Brasil é o padrão; o inglês é a opção da extensão (tokenometro.idioma)
export type Idioma = 'pt-BR' | 'en'

export function lerIdioma(valor: unknown): Idioma {
  return valor === 'en' ? 'en' : 'pt-BR'
}

function modeloDoLimite(kind: string): string {
  // Nome interno do "Fable limit" no painel de uso do Claude Code
  if (kind === 'seven_day_overage_included') return 'Fable'
  const modelo = kind.startsWith('seven_day_') ? kind.slice('seven_day_'.length).replace(/_/g, ' ') : ''
  return modelo ? `${modelo.charAt(0).toUpperCase()}${modelo.slice(1)}` : ''
}

// Em inglês, os mesmos nomes do painel de uso do Claude Code
export function nomeLimite(kind: string, idioma: Idioma = 'pt-BR'): string {
  const ingles = idioma === 'en'
  if (kind === 'five_hour') return ingles ? '5hr' : '5h'
  if (kind === 'seven_day') return ingles ? '7 day' : '7 dias'
  const modelo = modeloDoLimite(kind)
  if (!modelo) return kind
  return ingles ? `${modelo} limit` : modelo
}

// Nome por extenso, para o aviso na tela
function nomeLongo(kind: string, idioma: Idioma): string {
  const modelo = modeloDoLimite(kind)
  if (idioma === 'en') {
    if (kind.startsWith('five_hour')) return 'the 5-hour limit'
    if (kind === 'seven_day') return 'the weekly limit'
    return modelo ? `the weekly ${modelo} limit` : `the ${kind} limit`
  }
  if (kind.startsWith('five_hour')) return 'o limite de 5 horas'
  if (kind === 'seven_day') return 'o limite semanal'
  return modelo ? `o limite semanal do ${modelo}` : `o limite ${kind}`
}

export const DENTRO_DOS_LIMITES = 'Uso de tokens dentro dos limites'
const DENTRO_DOS_LIMITES_EN = 'Token usage within limits'

export function dentroDosLimites(idioma: Idioma = 'pt-BR'): string {
  return idioma === 'en' ? DENTRO_DOS_LIMITES_EN : DENTRO_DOS_LIMITES
}

// A linha gravada pode ter vindo de qualquer um dos dois idiomas
export function eDentroDosLimites(texto: string | null): boolean {
  return texto === DENTRO_DOS_LIMITES || texto === DENTRO_DOS_LIMITES_EN
}

export function registrarAmostra(
  janela: Janela | undefined,
  kind: string,
  resetsAt: number,
  agora: number,
  pct: number,
): Janela {
  // Renovação mudou: é outra janela, e as leituras da anterior não servem para o ritmo
  const atual =
    janela && janela.kind === kind && Math.abs(janela.resetsAt - resetsAt) <= 5 * MINUTO
      ? janela
      : { kind, resetsAt, pts: [] }
  const ultima = atual.pts[atual.pts.length - 1]
  const repetida = ultima !== undefined && ultima.p === pct && agora - ultima.t < 10 * MINUTO
  if (repetida) return atual
  return { ...atual, resetsAt, pts: [...atual.pts, { t: agora, p: pct }].slice(-500) }
}

export function registrarAtividade(perfil: Perfil | undefined, agora: number): Perfil {
  const hora = Math.floor(agora / HORA) * HORA
  const base = perfil ?? { desde: hora, ultima: agora, horas: [] }
  const horas = base.horas.includes(hora) ? base.horas : [...base.horas, hora]
  return { desde: base.desde, ultima: agora, horas: horas.filter(h => agora - h <= RETENCAO) }
}

// Sem histórico, supõe dias úteis das 8h às 18h; fora disso, um uso eventual
function pesoPadrao(ms: number): number {
  const d = new Date(ms)
  const dia = d.getDay()
  const h = d.getHours()
  return dia >= 1 && dia <= 5 && h >= 8 && h < 18 ? 0.9 : 0.03
}

function faixaSemanal(ms: number): number {
  const d = new Date(ms)
  return d.getDay() * 24 + d.getHours()
}

// Chance de uso em cada hora da semana: o que o perfil observou, misturado ao padrão até haver 3 semanas de registro
export function criarPesos(perfil: Perfil | undefined, agora: number): (ms: number) => number {
  if (!perfil) return pesoPadrao
  const semanas = Math.min(5, Math.max(0, (agora - perfil.desde) / SEMANA))
  const confianca = Math.min(1, semanas / 3)
  if (confianca === 0) return pesoPadrao
  const semanasPorFaixa = new Map<number, Set<number>>()
  for (const h of perfil.horas) {
    const faixa = faixaSemanal(h)
    const lista = semanasPorFaixa.get(faixa) ?? new Set<number>()
    lista.add(Math.floor((h - perfil.desde) / SEMANA))
    semanasPorFaixa.set(faixa, lista)
  }
  const total = Math.max(1, Math.ceil(semanas))
  return ms => {
    const observado = Math.min(1, (semanasPorFaixa.get(faixaSemanal(ms))?.size ?? 0) / total)
    return Math.max(0.02, confianca * observado + (1 - confianca) * pesoPadrao(ms))
  }
}

// Horas de uso já passadas entre ini e fim: o que o perfil registrou e, antes do registro começar, o padrão
function horasUsadas(ini: number, fim: number, perfil: Perfil | undefined, pesos: (ms: number) => number): number {
  const registradas = new Set(perfil?.horas ?? [])
  let soma = 0
  for (let t = ini; t < fim; ) {
    const inicioHora = Math.floor(t / HORA) * HORA
    const fimTrecho = Math.min(fim, inicioHora + HORA)
    const fracao = (fimTrecho - t) / HORA
    const registrado = perfil !== undefined && inicioHora >= perfil.desde
    soma += fracao * (registrado ? (registradas.has(inicioHora) ? 1 : 0) : pesos(t))
    t = fimTrecho
  }
  return soma
}

export function prever(
  kind: string,
  pct: number,
  resetsAt: number,
  agora: number,
  pts: readonly Amostra[],
  perfil?: Perfil,
  ritmoAnterior?: number,
): Previsao {
  const base: Previsao = {
    kind,
    pct,
    resetsAt,
    ritmoPorHora: null,
    origem: null,
    horasRestantes: 0,
    // Limite já esgotado conta como risco mesmo sem ritmo medido
    esgotaEm: pct >= 100 ? agora : null,
    pctNaRenovacao: null,
  }
  const duracao = duracaoDe(kind)
  if (duracao === undefined) return base
  const pesos = criarPesos(perfil, agora)
  let ritmo: number | null = null
  let origem: OrigemRitmo | null = null
  if (duracao !== SEMANA) {
    const recentes = pts.filter(a => agora - a.t <= RECENTE_MS)
    const ini = recentes[0]
    const fim = recentes[recentes.length - 1]
    if (ini && fim && fim.t - ini.t >= SPAN_MINIMO_MS) {
      ritmo = Math.max(0, (fim.p - ini.p) / ((fim.t - ini.t) / HORA))
      origem = 'recente'
    }
  }
  if (ritmo === null) {
    const usadas = horasUsadas(resetsAt - duracao, agora, perfil, pesos)
    if (usadas >= minimoHorasUso(duracao)) {
      ritmo = pct / usadas
      origem = 'janela'
    }
  }
  // Janela recém-começada: o ritmo da janela anterior é a melhor estimativa que existe
  if (ritmo === null && ritmoAnterior !== undefined) {
    ritmo = ritmoAnterior
    origem = 'anterior'
  }
  if (ritmo === null) return base
  const ativoAgora = perfil !== undefined && agora - perfil.ultima <= ATIVO_MS
  let p = pct
  let esgotaEm: number | null = pct >= 100 ? agora : null
  let horasRestantes = 0
  for (let t = agora; t < resetsAt; ) {
    const fimTrecho = Math.min(resetsAt, (Math.floor(t / HORA) + 1) * HORA)
    const fracao = (fimTrecho - t) / HORA
    const peso = ativoAgora && t === agora ? 1 : pesos(t)
    const ganho = ritmo * peso * fracao
    if (esgotaEm === null && ganho > 0 && p + ganho >= 100) {
      esgotaEm = t + ((100 - p) / (ritmo * peso)) * HORA
    }
    p += ganho
    horasRestantes += peso * fracao
    t = fimTrecho
  }
  return { ...base, ritmoPorHora: ritmo, origem, horasRestantes, esgotaEm, pctNaRenovacao: Math.min(999, p) }
}

// Acabar exatamente na renovação ou depois conta como dentro do limite
export function vaiEsgotar(p: Previsao): boolean {
  return p.esgotaEm !== null && p.esgotaEm < p.resetsAt
}

export function pertoDoLimite(p: Previsao): boolean {
  return !vaiEsgotar(p) && (p.pctNaRenovacao ?? p.pct) >= PERTO_DO_LIMITE
}

export function temFolga(p: Previsao): boolean {
  return p.ritmoPorHora !== null && (p.pctNaRenovacao ?? p.pct) < FOLGA
}

// Quantas vezes o ritmo atual caberia até a renovação sem acabar; null sem ritmo medido
export function multiploRitmo(p: Previsao): number | null {
  if (p.ritmoPorHora === null || p.pctNaRenovacao === null) return null
  const previsto = p.pctNaRenovacao - p.pct
  if (previsto <= 0) return null
  return (100 - p.pct) / previsto
}

// Maior ritmo, por hora de uso, que ainda chega à renovação sem acabar o limite
export function ritmoMaximo(p: Previsao): number | null {
  if (p.horasRestantes <= 0) return null
  return Math.max(0, (100 - p.pct) / p.horasRestantes)
}

// 0 sem risco, 1 acaba antes da renovação, 2 acaba em menos de 30 minutos
export function nivelRisco(p: Previsao, agora: number): number {
  if (!vaiEsgotar(p)) return 0
  return (p.esgotaEm ?? agora) - agora <= 30 * MINUTO ? 2 : 1
}

function decimal(n: number, idioma: Idioma): string {
  const texto = n.toFixed(1)
  return idioma === 'en' ? texto : texto.replace('.', ',')
}

export type FormatoHora = { preset: 'auto' | '12-hour' | '24-hour' | '24-hour-utc'; timeZone?: string }

export const FORMATO_PADRAO: FormatoHora = { preset: 'auto' }

function fusoValido(fuso: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fuso })
    return true
  } catch {
    return false
  }
}

// Lê timeFormat e timeZone do Claude Code com a mesma regra do painel de uso, para os horários baterem
export function lerFormato(timeFormat: unknown, timeZone: unknown): FormatoHora {
  const fuso = typeof timeZone === 'string' && fusoValido(timeZone) ? timeZone : undefined
  const valor = typeof timeFormat === 'string' ? timeFormat : 'auto'
  if (valor === '24-hour-utc') return { preset: valor, timeZone: 'UTC' }
  if (valor === '12-hour' || valor === '24-hour') return { preset: valor, timeZone: fuso }
  // Com um padrão strftime, o painel só olha se a hora vai de 0 a 23 para escrever a renovação
  if (valor.includes('%')) {
    return { preset: /%-?[HkRT]/.test(valor.replaceAll('%%', '')) ? '24-hour' : 'auto', timeZone: fuso }
  }
  return { preset: 'auto', timeZone: fuso }
}

// Ano, mês e dia no fuso escolhido, para saber se duas datas caem no mesmo dia
function chaveDia(ms: number, fuso: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

// Para o aviso e o /limite: "hoje às 15h40", "amanhã às 09h00", "quinta, 13/11, às 14h30";
// em inglês, "today at 3:40 PM", "Thursday, Nov 13 at 2:30 PM"
export function quando(ms: number, agora: number, f: FormatoHora = FORMATO_PADRAO, idioma: Idioma = 'pt-BR'): string {
  const fuso = f.timeZone
  const dia = chaveDia(ms, fuso)
  if (idioma === 'en') {
    const hora = horaPainel(ms, f, idioma)
    if (dia === chaveDia(agora, fuso)) return `today at ${hora}`
    if (dia === chaveDia(agora + DIA, fuso)) return `tomorrow at ${hora}`
    const data = new Intl.DateTimeFormat('en-US', { timeZone: fuso, weekday: 'long', month: 'short', day: 'numeric' }).format(ms)
    return `${data} at ${hora}`
  }
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms)
  const parte = (tipo: Intl.DateTimeFormatPartTypes): string => partes.find(p => p.type === tipo)?.value ?? ''
  const hora = `${parte('hour')}h${parte('minute')}`
  if (dia === chaveDia(agora, fuso)) return `hoje às ${hora}`
  if (dia === chaveDia(agora + DIA, fuso)) return `amanhã às ${hora}`
  return `${parte('weekday').replace('-feira', '')}, ${parte('day')}/${parte('month')}, às ${hora}`
}

// Em português, 24 horas, a não ser que o timeFormat do Claude Code peça 12 horas; em inglês, como o painel
// de uso: 12 horas, a não ser que o timeFormat peça 24
function horaPainel(ms: number, f: FormatoHora, idioma: Idioma): string {
  const vinteQuatro = idioma === 'en' ? f.preset === '24-hour' || f.preset === '24-hour-utc' : f.preset !== '12-hour'
  const opcoes: Intl.DateTimeFormatOptions = {
    hour: idioma === 'en' ? 'numeric' : '2-digit',
    minute: '2-digit',
    timeZone: f.timeZone,
    hourCycle: vinteQuatro ? 'h23' : 'h12',
  }
  const texto = new Intl.DateTimeFormat(idioma === 'en' ? 'en-US' : 'pt-BR', opcoes).format(ms)
  return f.preset === '24-hour-utc' ? `${texto} UTC` : texto
}

// "hoje", "amanhã" ou "qui, 19/11"; em inglês, "Thu, Nov 19", como o painel de uso; com o ano quando não é o deste ano
function dataPainel(ms: number, agora: number, f: FormatoHora, idioma: Idioma): string {
  const dia = chaveDia(ms, f.timeZone)
  const outroAno = dia.slice(0, 4) !== chaveDia(agora, f.timeZone).slice(0, 4)
  if (idioma === 'en') {
    const opcoes: Intl.DateTimeFormatOptions = { timeZone: f.timeZone, weekday: 'short', month: 'short', day: 'numeric' }
    if (outroAno) opcoes.year = 'numeric'
    return new Intl.DateTimeFormat('en-US', opcoes).format(ms)
  }
  if (dia === chaveDia(agora, f.timeZone)) return 'hoje'
  if (dia === chaveDia(agora + DIA, f.timeZone)) return 'amanhã'
  const opcoes: Intl.DateTimeFormatOptions = { timeZone: f.timeZone, day: '2-digit', month: '2-digit' }
  if (outroAno) opcoes.year = 'numeric'
  const semana = new Intl.DateTimeFormat('pt-BR', { timeZone: f.timeZone, weekday: 'short' }).format(ms).replace('.', '')
  return `${semana}, ${new Intl.DateTimeFormat('pt-BR', opcoes).format(ms)}`
}

// No limite de 5 horas basta a hora quando falta menos de um dia; nos outros, dia e hora
export function quandoPainel(ms: number, agora: number, kind: string, f: FormatoHora, idioma: Idioma = 'pt-BR'): string {
  if (ms - agora < MINUTO) return idioma === 'en' ? 'soon' : 'em instantes'
  if (ms - agora < DIA && kind === 'five_hour') return horaPainel(ms, f, idioma)
  return `${dataPainel(ms, agora, f, idioma)} ${idioma === 'en' ? 'at' : 'às'} ${horaPainel(ms, f, idioma)}`
}

// "renova 13:10", "renova qui, 19/11 às 00:00"; em inglês, "Resets 1:10 PM", como o painel de uso
export function renovaPainel(ms: number, agora: number, kind: string, f: FormatoHora, idioma: Idioma = 'pt-BR'): string {
  return `${idioma === 'en' ? 'Resets' : 'renova'} ${quandoPainel(ms, agora, kind, f, idioma)}`
}

// Ordem fixa, como no painel: sessão, semana e depois os limites por modelo
function ordem(kind: string): number {
  if (kind === 'five_hour') return 0
  if (kind === 'seven_day') return 1
  return 2
}

// Só os limites que vão esgotar antes de renovar; sem nenhum, a linha diz que está tudo dentro dos limites
export function textoStatus(
  previsoes: readonly Previsao[],
  agora: number,
  f: FormatoHora = FORMATO_PADRAO,
  idioma: Idioma = 'pt-BR',
): string | undefined {
  if (!previsoes.length) return undefined
  const risco = [...previsoes].filter(vaiEsgotar).sort((a, b) => ordem(a.kind) - ordem(b.kind))
  if (!risco.length) return dentroDosLimites(idioma)
  const partes = risco.map(
    p => `${nomeLimite(p.kind, idioma)}: ${situacaoPainel(p, agora, f, idioma)} (${renovaPainel(p.resetsAt, agora, p.kind, f, idioma)})`,
  )
  return `⚠ ${partes.join(' | ')}`
}

// A menos de um minuto, ou com o limite já no fim, "irá esgotar" deixa de descrever a situação
function situacaoPainel(p: Previsao, agora: number, f: FormatoHora, idioma: Idioma): string {
  const ingles = idioma === 'en'
  if (p.pct >= 100) return ingles ? 'used up' : 'esgotado'
  const esgotaEm = p.esgotaEm ?? agora
  if (esgotaEm - agora < MINUTO) return ingles ? 'running out now' : 'esgotando agora'
  const momento = quandoPainel(esgotaEm, agora, p.kind, f, idioma)
  if (!ingles) return `irá esgotar ${momento}`
  // Só a hora pede "at" na frente; com a data, o "at" já vem no meio ("Thu, Nov 19 at 3:00 PM")
  return `runs out ${/^\d/.test(momento) ? 'at ' : ''}${momento}`
}

export function textoAviso(p: Previsao, agora: number, f: FormatoHora = FORMATO_PADRAO, idioma: Idioma = 'pt-BR'): string {
  const nome = nomeLongo(p.kind, idioma)
  const renova = quando(p.resetsAt, agora, f, idioma)
  if (idioma === 'en') {
    if (p.pct >= 100) return `Heads up: ${nome} is used up.\nIt only resets ${renova}.`
    return `Heads up: at this pace, ${nome} will run out ${quando(p.esgotaEm ?? agora, agora, f, idioma)}.\nIt only resets ${renova}.`
  }
  if (p.pct >= 100) return `Atenção: ${nome} esgotou.\nEle só renova ${renova}.`
  return `Atenção: se continuar nesse ritmo, ${nome} irá esgotar ${quando(p.esgotaEm ?? agora, agora, f, idioma)}.\nEle só renova ${renova}.`
}

const TEXTO_ORIGEM: Record<Idioma, Record<OrigemRitmo, string>> = {
  'pt-BR': {
    recente: 'medido nos últimos 45 minutos',
    janela: 'média das horas em que você usou nesta janela',
    anterior: 'da janela anterior, porque esta começou há pouco',
  },
  en: {
    recente: 'measured over the last 45 minutes',
    janela: 'average of the hours you used in this window',
    anterior: 'from the previous window, since this one just started',
  },
}

export function textoDetalhe(p: Previsao, agora: number, f: FormatoHora = FORMATO_PADRAO, idioma: Idioma = 'pt-BR'): string {
  const ingles = idioma === 'en'
  const d = (n: number): string => decimal(n, idioma)
  const linhas = ingles
    ? [`${nomeLimite(p.kind, idioma)}: ${Math.round(p.pct)}% used.`, `Resets ${quando(p.resetsAt, agora, f, idioma)}.`]
    : [`${nomeLimite(p.kind, idioma)}: ${Math.round(p.pct)}% usado.`, `Renova ${quando(p.resetsAt, agora, f, idioma)}.`]
  if (p.pct >= 100) {
    linhas.push(ingles ? 'The limit is used up: it comes back at the reset.' : 'O limite esgotou: volta a valer na renovação.')
    return linhas.join('\n')
  }
  if (p.ritmoPorHora === null) {
    linhas.push(
      ingles
        ? 'The window just started: there is not enough data to measure the pace yet.'
        : 'A janela começou há pouco: ainda não dá para calcular o ritmo.',
    )
    return linhas.join('\n')
  }
  const origem = p.origem ? ` (${TEXTO_ORIGEM[idioma][p.origem]})` : ''
  if (ingles) {
    linhas.push(`Pace: ${d(p.ritmoPorHora)}% per hour of use${origem}.`)
    linhas.push(`About ${d(p.horasRestantes)} hours of use until the reset, based on your schedule.`)
  } else {
    linhas.push(`Ritmo: ${d(p.ritmoPorHora)}% por hora de uso${origem}.`)
    linhas.push(`Até a renovação, devem ser cerca de ${d(p.horasRestantes)} horas de uso, pelo seu horário.`)
  }
  const naRenovacao = Math.round(p.pctNaRenovacao ?? p.pct)
  const maximo = ritmoMaximo(p)
  if (vaiEsgotar(p)) {
    const momento = quando(p.esgotaEm ?? agora, agora, f, idioma)
    linhas.push(ingles ? `Heads up: at this pace, it runs out ${momento}, before the reset.` : `Atenção: nesse ritmo, irá esgotar ${momento}, antes de renovar.`)
    if (maximo !== null) {
      linhas.push(ingles ? `To make it to the reset, use at most ${d(maximo)}% per hour of use.` : `Para chegar até a renovação, use até ${d(maximo)}% por hora de uso.`)
    }
  } else if (pertoDoLimite(p)) {
    linhas.push(ingles ? `Close to the limit: at this pace, it reaches ${naRenovacao}% at the reset.` : `Perto do limite: nesse ritmo, chega a ${naRenovacao}% na renovação.`)
  } else if (temFolga(p)) {
    linhas.push(ingles ? `Room to spare: at this pace, it only reaches ${naRenovacao}% at the reset.` : `Pode usar mais: nesse ritmo, chega só a ${naRenovacao}% na renovação.`)
    const multiplo = multiploRitmo(p)
    if (maximo !== null && multiplo !== null && multiplo >= 1.1) {
      linhas.push(
        ingles
          ? `The pace can go up to ${d(maximo)}% per hour of use (${d(multiplo)} times the current one) without running out.`
          : `O ritmo pode subir até ${d(maximo)}% por hora de uso (${d(multiplo)} vezes o atual) sem esgotar.`,
      )
    }
  } else {
    linhas.push(ingles ? `Within the limit: at this pace, it reaches ${naRenovacao}% at the reset.` : `Dentro do limite: nesse ritmo, chega a ${naRenovacao}% na renovação.`)
  }
  return linhas.join('\n')
}
