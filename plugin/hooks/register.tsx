import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import {
  duracaoDe,
  eDentroDosLimites,
  type FormatoHora,
  type Idioma,
  type Janela,
  lerFormato,
  lerIdioma,
  nomeLimite,
  type Perfil,
  type Previsao,
  nivelRisco,
  prever,
  registrarAmostra,
  registrarAtividade,
  textoAviso,
  textoDetalhe,
  textoStatus,
  vaiEsgotar,
} from './previsao'

type Aviso = { resetsAt: number; nivel: number }
type RitmoSalvo = { resetsAt: number; ritmo: number }
type Config = { abrirPainel: boolean; idioma: Idioma }

const PAINEL = 'uso'
const linha = atom({ plugin: 'tokenometro', key: 'linha' } as const, null)

// A linha de status leva o nome do plugin na frente; o painel, sozinho, não leva título nenhum.
// Enquanto o painel não está na tela, a previsão vai para a linha de status para não sumir.
let noPainel = false
// No terminal a previsão vai para a faixa acima do prompt e para a dica abaixo dele, sem o "tokenometro plugin"
// na frente. Nas outras telas fica a linha de status: o VS Code desenha a faixa como um quadro com título,
// que ocupa mais espaço que a linha
let naFaixa = false
// Atualizado a cada leitura do config.json, para a troca de idioma valer já na próxima resposta
let idioma: Idioma = 'pt-BR'

function sairDaLinhaDeStatus($: EngineInterface): void {
  if (naFaixa) return
  naFaixa = true
  $.ui.status(undefined)
}

function semLeitura(): string {
  return idioma === 'en'
    ? 'No limit reading in this session yet.\nIt arrives with the first model response and only exists on subscription plans.'
    : 'Ainda não há leitura do limite nesta sessão.\nEla chega com a primeira resposta do modelo e só existe em plano de assinatura.'
}

async function mostrar($: EngineInterface, texto: string | undefined): Promise<void> {
  await update($, linha, () => texto ?? null)
  $.ui.status(noPainel || naFaixa ? undefined : texto)
}

// A previsão é uma linha só: acima do prompt pede uma linha de altura e, encaixado ao lado da conversa
// (terminal em tela cheia), a menor largura que cabe a linha, para não tomar espaço do trabalho
async function abrirPainel($: EngineInterface): Promise<void> {
  const aberto = await $.ui.open({ id: PAINEL, title: 'Tokenômetro', rows: 1, columns: 30 })
  noPainel = aberto.isPlaced
  if (noPainel) $.ui.status(undefined)
}

async function atualizar(
  $: EngineInterface,
  limites: readonly SessionRateLimit[],
  avisar: boolean,
): Promise<{ previsoes: Previsao[]; ignorados: SessionRateLimit[]; agora: number; formato: FormatoHora }> {
  const agora = await $.clock.now()
  idioma = (await lerConfig($)).idioma
  // Lido a cada vez: trocar o formato ou o fuso no /config muda o mod junto com o painel de uso
  const formato = lerFormato(await $.settings.read({ key: 'timeFormat' }), await $.settings.read({ key: 'timeZone' }))
  const perfil = (await $.store.get('perfil')) as Perfil | undefined
  const previsoes: Previsao[] = []
  const ignorados: SessionRateLimit[] = []
  for (const limite of limites) {
    if (limite.resetsAt === undefined || duracaoDe(limite.kind) === undefined) {
      ignorados.push(limite)
      continue
    }
    const resetsAt = Date.parse(limite.resetsAt)
    if (Number.isNaN(resetsAt)) continue
    const chave = `janela:${limite.kind}`
    const janela = registrarAmostra(
      (await $.store.get(chave)) as Janela | undefined,
      limite.kind,
      resetsAt,
      agora,
      limite.percentUsed,
    )
    await $.store.set(chave, janela)
    const chaveRitmo = `ritmo:${limite.kind}`
    const salvo = (await $.store.get(chaveRitmo)) as RitmoSalvo | undefined
    const anterior = salvo !== undefined && salvo.resetsAt !== resetsAt ? salvo.ritmo : undefined
    const previsao = prever(limite.kind, limite.percentUsed, resetsAt, agora, janela.pts, perfil, anterior)
    previsoes.push(previsao)
    // Guarda o ritmo medido nesta janela para servir de estimativa no começo da próxima
    if (previsao.ritmoPorHora !== null && previsao.origem === 'janela') {
      await $.store.set(chaveRitmo, { resetsAt, ritmo: previsao.ritmoPorHora })
    }
    const nivel = nivelRisco(previsao, agora)
    if (avisar && nivel > 0) {
      // Um aviso por nível em cada janela, guardado entre sessões, para não repetir a cada resposta
      const chaveAviso = `aviso:${limite.kind}`
      const aviso = (await $.store.get(chaveAviso)) as Aviso | undefined
      const jaAvisou = aviso !== undefined && aviso.resetsAt === resetsAt && aviso.nivel >= nivel
      if (!jaAvisou) {
        $.ui.toast(textoAviso(previsao, agora, formato, idioma), { timeoutMs: 12_000 })
        await $.store.set(chaveAviso, { resetsAt, nivel })
      }
    }
  }
  const linhaPainel = textoStatus(previsoes, agora, formato, idioma)
  await mostrar($, linhaPainel)
  if (previsoes.length) await $.store.set('ultima', { linha: linhaPainel ?? null, validaAte: Math.min(...previsoes.map(p => p.resetsAt)) })
  await gravarArquivo($, previsoes, agora, formato, linhaPainel)
  return { previsoes, ignorados, agora, formato }
}

async function pastaDados($: EngineInterface): Promise<string | undefined> {
  const pasta = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return pasta ? `${pasta}/.claude/tokenometro` : undefined
}

// As opções ficam na extensão do VS Code, que grava o config.json; sem o arquivo, vale o padrão: painel fechado
// e textos em português
async function lerConfig($: EngineInterface): Promise<Config> {
  const padrao: Config = { abrirPainel: false, idioma: 'pt-BR' }
  const pasta = await pastaDados($)
  if (!pasta) return padrao
  try {
    const config = JSON.parse(String(await $.fs.read(`${pasta}/config.json`))) as { abrirPainel?: unknown; idioma?: unknown }
    return { abrirPainel: config.abrirPainel === true, idioma: lerIdioma(config.idioma) }
  } catch {
    return padrao
  }
}

// A extensão do VS Code não recebe o dado de limite; ela lê a previsão que este plugin grava aqui
async function gravarArquivo(
  $: EngineInterface,
  previsoes: readonly Previsao[],
  agora: number,
  formato: FormatoHora,
  linhaPainel: string | undefined,
): Promise<void> {
  const pasta = await pastaDados($)
  if (!pasta || !previsoes.length) return
  const conteudo = {
    versao: 1,
    atualizadoEm: agora,
    linha: linhaPainel ?? null,
    emRisco: previsoes.some(vaiEsgotar),
    limites: previsoes.map(p => ({
      kind: p.kind,
      nome: nomeLimite(p.kind, idioma),
      pct: p.pct,
      resetsAt: p.resetsAt,
      esgotaEm: vaiEsgotar(p) ? p.esgotaEm : null,
      detalhe: textoDetalhe(p, agora, formato, idioma),
    })),
  }
  await $.fs.write(`${pasta}/previsao.json`, JSON.stringify(conteudo, null, 2))
}

// Logo depois de abrir a sessão ainda não há leitura: mostra a última previsão enquanto nenhum limite renovou
async function mostrarUltima($: EngineInterface): Promise<void> {
  const ultima = (await $.store.get('ultima')) as { linha: string | null; validaAte: number } | undefined
  if (ultima?.linha && ultima.validaAte > (await $.clock.now())) await mostrar($, ultima.linha)
}

// O detalhe sai na conversa; o painel não abre aqui porque no terminal em tela cheia ele ocupa uma coluna inteira
async function detalhar($: EngineInterface): Promise<{ text: string }> {
  const uso = await $.session.usage()
  const { previsoes, ignorados, agora, formato } = await atualizar($, uso.rateLimits, false)
  if (!previsoes.length && !ignorados.length) return { text: semLeitura() }
  // Limite que o mod não sabe a duração: lista o nome interno para dar para incluir depois
  const desconhecidos = ignorados.map(l =>
    idioma === 'en'
      ? `Limit not recognized by the mod: ${l.kind} (${Math.round(l.percentUsed)}% used).`
      : `Limite não reconhecido pelo mod: ${l.kind} (${Math.round(l.percentUsed)}% usado).`,
  )
  return { text: [...previsoes.map(p => textoDetalhe(p, agora, formato, idioma)), ...desconhecidos].join('\n\n') }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    const config = await lerConfig($)
    idioma = config.idioma
    // O comando é registrado na sessão no idioma escolhido: /limite em português, /limit em inglês
    await $.command.register(
      idioma === 'en'
        ? { name: 'limit', description: 'Shows the usage limit forecast at your pace' }
        : { name: 'limite', description: 'Mostra a previsão dos limites de uso no seu ritmo' },
    )
    if (config.abrirPainel) await abrirPainel($)
    const uso = await $.session.usage()
    if (uso.rateLimits.length) await atualizar($, uso.rateLimits, false)
    else await mostrarUltima($)
    return ran
  })

  // Cada medição vem de uma resposta do modelo: marca a hora como hora de uso, que ensina o seu horário
  on('session.measure', async ($, e, next) => {
    const agora = await $.clock.now()
    await $.store.set('perfil', registrarAtividade((await $.store.get('perfil')) as Perfil | undefined, agora))
    if (e.rateLimits.length) await atualizar($, e.rateLimits, true)
    return next(e)
  })

  on('command.run', { command: 'limite' }, detalhar)
  on('command.run', { command: 'limit' }, detalhar)

  // Fechou o painel: a previsão volta para a linha de status
  on('ui.close', async ($, e, next) => {
    if (e.id === PAINEL && e.origin.kind !== 'unload') {
      noPainel = false
      if (!naFaixa) $.ui.status((await read($, linha)) ?? undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PAINEL }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const texto = await read($, linha)
    const aguardando =
      idioma === 'en' ? 'Token usage: waiting for the first limit reading.' : 'Uso de tokens: aguardando a primeira leitura do limite.'
    // Acima do prompt fica numa linha só, cortada no fim; na coluna estreita ao lado da conversa quebra a linha,
    // senão a data de renovação some
    return (
      <Text wrap={e.props.placement === 'dock' ? 'wrap' : 'truncate-end'} size="caption" dimColor={texto === null}>
        {texto ?? aguardando}
      </Text>
    )
  })

  // A faixa acima do prompt só aparece com aviso: dentro dos limites ela fica livre e o estado vai para a dica
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    sairDaLinhaDeStatus($)
    const texto = await read($, linha)
    if (e.props.hasSurvey || noPainel || texto === null || eDentroDosLimites(texto)) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text color="warning" wrap="truncate-end">
        {texto}
      </Text>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    sairDaLinhaDeStatus($)
    const texto = await read($, linha)
    if (noPainel || texto === null || !eDentroDosLimites(texto)) return next(e)
    return next({ ...e, props: { ...e.props, tail: `· ${texto}` } })
  })
}
