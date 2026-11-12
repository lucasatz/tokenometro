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

function modeloDoLimite(kind: string): string {
  // Nome interno do "Fable limit" no painel de uso do Claude Code
  if (kind === 'seven_day_overage_included') return 'Fable'
  const modelo = kind.startsWith('seven_day_') ? kind.slice('seven_day_'.length).replace(/_/g, ' ') : ''
  return modelo ? `${modelo.charAt(0).toUpperCase()}${modelo.slice(1)}` : ''
}

export function nomeLimite(kind: string): string {
  if (kind === 'five_hour') return '5hr'
  if (kind === 'seven_day') return '7 day'
  const modelo = modeloDoLimite(kind)
  return modelo ? `${modelo} limit` : kind
}

// Nome por extenso, em português, para o aviso na tela
function nomeLongo(kind: string): string {
  if (kind.startsWith('five_hour')) return 'o limite de 5 horas'
  if (kind === 'seven_day') return 'o limite semanal'
  const modelo = modeloDoLimite(kind)
  return modelo ? `o limite semanal do ${modelo}` : `o limite ${kind}`
}

export const DENTRO_DOS_LIMITES = 'Uso de tokens dentro dos limites'

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
    esgotaEm: null,
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

function decimal(n: number): string {
  return n.toFixed(1).replace('.', ',')
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

// Para o aviso e o /limite, em português: "hoje às 15h40", "amanhã às 09h00", "quinta, 13/11, às 14h30"
export function quando(ms: number, agora: number, fuso?: string): string {
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
  const dia = chaveDia(ms, fuso)
  if (dia === chaveDia(agora, fuso)) return `hoje às ${hora}`
  if (dia === chaveDia(agora + DIA, fuso)) return `amanhã às ${hora}`
  return `${parte('weekday').replace('-feira', '')}, ${parte('day')}/${parte('month')}, às ${hora}`
}

// No modo "auto" o painel segue o idioma do VS Code; sem idioma definido nele, é o inglês
const IDIOMA_PAINEL = 'en-US'

function horaPainel(ms: number, f: FormatoHora): string {
  const opcoes: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', timeZone: f.timeZone }
  if (f.preset === '12-hour') opcoes.hourCycle = 'h12'
  if (f.preset === '24-hour' || f.preset === '24-hour-utc') opcoes.hourCycle = 'h23'
  const texto = new Intl.DateTimeFormat(IDIOMA_PAINEL, opcoes).format(ms)
  return f.preset === '24-hour-utc' ? `${texto}Z` : texto
}

// A data o painel escreve sempre em inglês, "Thu, Nov 19", com o ano quando não é o deste ano
function dataPainel(ms: number, agora: number, f: FormatoHora): string {
  const opcoes: Intl.DateTimeFormatOptions = { timeZone: f.timeZone, weekday: 'short', month: 'short', day: 'numeric' }
  if (chaveDia(ms, f.timeZone).slice(0, 4) !== chaveDia(agora, f.timeZone).slice(0, 4)) opcoes.year = 'numeric'
  return new Intl.DateTimeFormat('en-US', opcoes).format(ms)
}

// Regra do painel: só a hora quando falta menos de um dia no limite de 5 horas; nos outros, dia e hora
export function quandoPainel(ms: number, agora: number, kind: string, f: FormatoHora): string {
  if (ms - agora < MINUTO) return 'soon'
  if (ms - agora < DIA && kind === 'five_hour') return horaPainel(ms, f)
  return `${dataPainel(ms, agora, f)} at ${horaPainel(ms, f)}`
}

// "Resets 13:10" ou "Resets Thu, Nov 19 at 00:00"
export function renovaPainel(ms: number, agora: number, kind: string, f: FormatoHora): string {
  return `Resets ${quandoPainel(ms, agora, kind, f)}`
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
): string | undefined {
  if (!previsoes.length) return undefined
  const risco = [...previsoes].filter(vaiEsgotar).sort((a, b) => ordem(a.kind) - ordem(b.kind))
  if (!risco.length) return DENTRO_DOS_LIMITES
  const partes = risco.map(
    p =>
      `${nomeLimite(p.kind)}: irá esgotar ${quandoPainel(p.esgotaEm ?? agora, agora, p.kind, f)} ` +
      `(${renovaPainel(p.resetsAt, agora, p.kind, f)})`,
  )
  return `⚠ ${partes.join(' | ')}`
}

export function textoAviso(p: Previsao, agora: number, f: FormatoHora = FORMATO_PADRAO): string {
  return (
    `Atenção: se continuar nesse ritmo, ${nomeLongo(p.kind)} irá esgotar ${quando(p.esgotaEm ?? agora, agora, f.timeZone)}.\n` +
    `Ele só renova ${quando(p.resetsAt, agora, f.timeZone)}.`
  )
}

const TEXTO_ORIGEM: Record<OrigemRitmo, string> = {
  recente: 'medido nos últimos 45 minutos',
  janela: 'média das horas em que você usou nesta janela',
  anterior: 'da janela anterior, porque esta começou há pouco',
}

export function textoDetalhe(p: Previsao, agora: number, f: FormatoHora = FORMATO_PADRAO): string {
  const linhas = [`${nomeLimite(p.kind)}: ${Math.round(p.pct)}% usado.`, `Renova ${quando(p.resetsAt, agora, f.timeZone)}.`]
  if (p.ritmoPorHora === null) {
    linhas.push('A janela começou há pouco: ainda não dá para calcular o ritmo.')
    return linhas.join('\n')
  }
  const origem = p.origem ? ` (${TEXTO_ORIGEM[p.origem]})` : ''
  linhas.push(`Ritmo: ${decimal(p.ritmoPorHora)}% por hora de uso${origem}.`)
  linhas.push(`Até a renovação, devem ser cerca de ${decimal(p.horasRestantes)} horas de uso, pelo seu horário.`)
  const naRenovacao = Math.round(p.pctNaRenovacao ?? p.pct)
  const maximo = ritmoMaximo(p)
  if (vaiEsgotar(p)) {
    linhas.push(`Atenção: nesse ritmo, irá esgotar ${quando(p.esgotaEm ?? agora, agora, f.timeZone)}, antes de renovar.`)
    if (maximo !== null) linhas.push(`Para chegar até a renovação, use até ${decimal(maximo)}% por hora de uso.`)
  } else if (pertoDoLimite(p)) {
    linhas.push(`Perto do limite: nesse ritmo, chega a ${naRenovacao}% na renovação.`)
  } else if (temFolga(p)) {
    linhas.push(`Pode usar mais: nesse ritmo, chega só a ${naRenovacao}% na renovação.`)
    const multiplo = multiploRitmo(p)
    if (maximo !== null && multiplo !== null && multiplo >= 1.1) {
      linhas.push(`O ritmo pode subir até ${decimal(maximo)}% por hora de uso (${decimal(multiplo)} vezes o atual) sem esgotar.`)
    }
  } else {
    linhas.push(`Dentro do limite: nesse ritmo, chega a ${naRenovacao}% na renovação.`)
  }
  return linhas.join('\n')
}
