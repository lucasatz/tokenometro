import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import {
  DENTRO_DOS_LIMITES,
  duracaoDe,
  type FormatoHora,
  type Janela,
  lerFormato,
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

const PAINEL = 'uso'
const linha = atom({ plugin: 'tokenometro', key: 'linha' } as const, null)

// A linha de status leva o nome do plugin na frente; o painel, sozinho, não leva título nenhum.
// Enquanto o painel não está na tela, a previsão vai para a linha de status para não sumir.
let noPainel = false
// No terminal a previsão vai para a faixa acima do prompt e para a dica abaixo dele, sem o "tokenometro plugin"
// na frente. Nas outras telas fica a linha de status: o VS Code desenha a faixa como um quadro com título,
// que ocupa mais espaço que a linha
let naFaixa = false

function sairDaLinhaDeStatus($: EngineInterface): void {
  if (naFaixa) return
  naFaixa = true
  $.ui.status(undefined)
}

const SEM_LEITURA =
  'Ainda não há leitura do limite nesta sessão.\n' +
  'Ela chega com a primeira resposta do modelo e só existe em plano de assinatura.'

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
        $.ui.toast(textoAviso(previsao, agora, formato), { timeoutMs: 12_000 })
        await $.store.set(chaveAviso, { resetsAt, nivel })
      }
    }
  }
  const linhaPainel = textoStatus(previsoes, agora, formato)
  await mostrar($, linhaPainel)
  if (previsoes.length) await $.store.set('ultima', { linha: linhaPainel ?? null, validaAte: Math.min(...previsoes.map(p => p.resetsAt)) })
  await gravarArquivo($, previsoes, agora, formato, linhaPainel)
  return { previsoes, ignorados, agora, formato }
}

async function pastaDados($: EngineInterface): Promise<string | undefined> {
  const pasta = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return pasta ? `${pasta}/.claude/tokenometro` : undefined
}

// A opção fica na extensão do VS Code, que grava o config.json; sem o arquivo, o painel não abre sozinho
// e a previsão fica na linha de status
async function abrirAoIniciar($: EngineInterface): Promise<boolean> {
  const pasta = await pastaDados($)
  if (!pasta) return false
  try {
    const config = JSON.parse(String(await $.fs.read(`${pasta}/config.json`))) as { abrirPainel?: unknown }
    return config.abrirPainel === true
  } catch {
    return false
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
      nome: nomeLimite(p.kind),
      pct: p.pct,
      resetsAt: p.resetsAt,
      esgotaEm: vaiEsgotar(p) ? p.esgotaEm : null,
      detalhe: textoDetalhe(p, agora, formato),
    })),
  }
  await $.fs.write(`${pasta}/previsao.json`, JSON.stringify(conteudo, null, 2))
}

// Logo depois de abrir a sessão ainda não há leitura: mostra a última previsão enquanto nenhum limite renovou
async function mostrarUltima($: EngineInterface): Promise<void> {
  const ultima = (await $.store.get('ultima')) as { linha: string | null; validaAte: number } | undefined
  if (ultima?.linha && ultima.validaAte > (await $.clock.now())) await mostrar($, ultima.linha)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'limite',
      description: 'Mostra a previsão dos limites de uso no seu ritmo',
    })
    if (await abrirAoIniciar($)) await abrirPainel($)
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

  // O detalhe sai na conversa; o painel não abre aqui porque no terminal em tela cheia ele ocupa uma coluna inteira
  on('command.run', { command: 'limite' }, async $ => {
    const uso = await $.session.usage()
    const { previsoes, ignorados, agora, formato } = await atualizar($, uso.rateLimits, false)
    if (!previsoes.length && !ignorados.length) return { text: SEM_LEITURA }
    // Limite que o mod não sabe a duração: lista o nome interno para dar para incluir depois
    const desconhecidos = ignorados.map(l => `Limite não reconhecido pelo mod: ${l.kind} (${Math.round(l.percentUsed)}% usado).`)
    return { text: [...previsoes.map(p => textoDetalhe(p, agora, formato)), ...desconhecidos].join('\n\n') }
  })

  // Fechou o painel: a previsão volta para a linha de status
  on('ui.close', async ($, e, next) => {
    if (e.id === PAINEL && e.origin !== 'unload') {
      noPainel = false
      if (!naFaixa) $.ui.status((await read($, linha)) ?? undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PAINEL }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const texto = await read($, linha)
    // Acima do prompt fica numa linha só, cortada no fim; na coluna estreita ao lado da conversa quebra a linha,
    // senão a data de renovação some
    return (
      <Text wrap={e.props.placement === 'dock' ? 'wrap' : 'truncate-end'} size="caption" dimColor={texto === null}>
        {texto ?? 'Uso de tokens: aguardando a primeira leitura do limite.'}
      </Text>
    )
  })

  // A faixa acima do prompt só aparece com aviso: dentro dos limites ela fica livre e o estado vai para a dica
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    sairDaLinhaDeStatus($)
    const texto = await read($, linha)
    if (e.props.hasSurvey || noPainel || texto === null || texto === DENTRO_DOS_LIMITES) return next(e)
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
    if (noPainel || texto !== DENTRO_DOS_LIMITES) return next(e)
    return next({ ...e, props: { ...e.props, tail: `· ${texto}` } })
  })
}
