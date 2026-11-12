const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PASTA_DADOS = path.join(os.homedir(), '.claude', 'tokenometro')
const ARQUIVO = path.join(PASTA_DADOS, 'previsao.json')
const CONFIG = path.join(PASTA_DADOS, 'config.json')
const PASTA_PLUGIN = path.join(PASTA_DADOS, 'plugin')
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
// Leitura com mais de 12 horas já não representa o uso atual
const VALIDADE_MS = 12 * 60 * 60 * 1000

let item
let observador
let espera

function activate(context) {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('tokenometro.mostrarDetalhes', mostrarDetalhes),
    vscode.commands.registerCommand('tokenometro.instalarPlugin', () => instalarPlugin(context, true)),
    vscode.commands.registerCommand('tokenometro.removerPlugin', removerPlugin),
  )
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tokenometro.barraDeStatus')) atualizar()
      if (e.affectsConfiguration('tokenometro.abrirPainelAoIniciar')) gravarConfig()
    }),
  )
  gravarConfig()
  sincronizarPlugin(context)
  observar()
  // Revê a cada minuto: a leitura envelhece e a renovação passa mesmo sem o arquivo mudar
  const relogio = setInterval(atualizar, 60 * 1000)
  context.subscriptions.push({
    dispose: () => {
      clearInterval(relogio)
      if (observador) observador.close()
    },
  })
  atualizar()
  oferecerInstalacao(context)
}

function deactivate() {}

function lerJson(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'))
  } catch {
    return null
  }
}

// Settings ausente vale como vazio; settings que não abre como JSON devolve null, para nunca ser sobrescrito
function lerSettings() {
  if (!fs.existsSync(SETTINGS)) return {}
  return lerJson(SETTINGS)
}

// O plugin roda dentro do Claude Code e não enxerga as configurações do VS Code: recebe a opção por este arquivo
function gravarConfig() {
  const abrirPainel = vscode.workspace.getConfiguration('tokenometro').get('abrirPainelAoIniciar', false)
  try {
    fs.mkdirSync(PASTA_DADOS, { recursive: true })
    fs.writeFileSync(CONFIG, `${JSON.stringify({ abrirPainel }, null, 2)}\n`)
  } catch {
    // Sem permissão de escrita o plugin segue o padrão, que é não abrir o painel sozinho
  }
}

function normalizar(pasta) {
  const caminho = path.resolve(pasta)
  return process.platform === 'win32' ? caminho.toLowerCase() : caminho
}

function pastasPlugins(settings) {
  const valor = settings && settings.env && settings.env.CLAUDE_CODE_PLUGIN_DIRS
  return typeof valor === 'string' ? valor.split(path.delimiter).filter(Boolean) : []
}

function pluginInstalado() {
  const registrado = pastasPlugins(lerSettings()).map(normalizar).includes(normalizar(PASTA_PLUGIN))
  return registrado && fs.existsSync(path.join(PASTA_PLUGIN, '.claude-plugin', 'plugin.json'))
}

function versaoPlugin(pasta) {
  const manifesto = lerJson(path.join(pasta, '.claude-plugin', 'plugin.json'))
  return manifesto ? manifesto.version : undefined
}

function copiarPlugin(context) {
  fs.rmSync(PASTA_PLUGIN, { recursive: true, force: true })
  fs.cpSync(path.join(context.extensionPath, 'plugin'), PASTA_PLUGIN, { recursive: true })
}

// Extensão atualizada leva junto a versão nova do plugin que ela traz
function sincronizarPlugin(context) {
  if (!pluginInstalado()) return
  if (versaoPlugin(PASTA_PLUGIN) === versaoPlugin(path.join(context.extensionPath, 'plugin'))) return
  try {
    copiarPlugin(context)
  } catch (erro) {
    // Sem permissão de escrita fica a versão anterior do plugin, que continua funcionando
    vscode.window.showWarningMessage(`Não foi possível atualizar o plugin do Claude Code: ${erro.message}`)
  }
}

async function oferecerInstalacao(context) {
  if (pluginInstalado() || context.globalState.get('perguntouInstalacao')) return
  await context.globalState.update('perguntouInstalacao', true)
  await instalarPlugin(context, true)
}

async function instalarPlugin(context, perguntar) {
  if (perguntar) {
    const resposta = await vscode.window.showInformationMessage(
      'Para mostrar a previsão, o Tokenômetro instala um plugin no Claude Code.',
      {
        modal: true,
        detail:
          `O plugin é copiado para ${PASTA_PLUGIN} e essa pasta é adicionada em CLAUDE_CODE_PLUGIN_DIRS, no ${SETTINGS}.\n` +
          'Ele começa a valer nas próximas sessões do Claude Code.',
      },
      'Instalar',
    )
    if (resposta !== 'Instalar') return
  }
  const settings = lerSettings()
  if (settings === null) {
    vscode.window.showErrorMessage(
      `Não foi possível ler o ${SETTINGS}.\n` +
        'Corrija o arquivo e rode o comando "Tokenômetro: Instalar plugin no Claude Code".',
    )
    return
  }
  try {
    copiarPlugin(context)
    const pastas = pastasPlugins(settings)
    if (!pastas.map(normalizar).includes(normalizar(PASTA_PLUGIN))) pastas.push(PASTA_PLUGIN)
    settings.env = { ...(settings.env || {}), CLAUDE_CODE_PLUGIN_DIRS: pastas.join(path.delimiter) }
    gravarSettings(settings)
  } catch (erro) {
    vscode.window.showErrorMessage(
      `Não foi possível instalar o plugin do Claude Code: ${erro.message}\n` +
        'Confira a permissão de escrita na pasta ~/.claude e rode o comando "Tokenômetro: Instalar plugin no Claude Code".',
    )
    return
  }
  atualizar()
  vscode.window.showInformationMessage(
    'Plugin instalado.\nAbra uma nova sessão do Claude Code para a previsão começar a aparecer.',
  )
}

function gravarSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.tokenometro.bak`)
  fs.writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`)
}

async function removerPlugin() {
  const resposta = await vscode.window.showWarningMessage(
    'Remover o plugin do Claude Code?',
    { modal: true, detail: 'A previsão deixa de ser calculada a partir da próxima sessão do Claude Code.' },
    'Remover',
  )
  if (resposta !== 'Remover') return
  const settings = lerSettings()
  if (settings === null) {
    vscode.window.showErrorMessage(`Não foi possível ler o ${SETTINGS}.\nCorrija o arquivo e tente de novo.`)
    return
  }
  const pastas = pastasPlugins(settings).filter(p => normalizar(p) !== normalizar(PASTA_PLUGIN))
  if (settings.env) {
    if (pastas.length) settings.env.CLAUDE_CODE_PLUGIN_DIRS = pastas.join(path.delimiter)
    else delete settings.env.CLAUDE_CODE_PLUGIN_DIRS
    if (!Object.keys(settings.env).length) delete settings.env
  }
  try {
    gravarSettings(settings)
    fs.rmSync(PASTA_PLUGIN, { recursive: true, force: true })
    fs.rmSync(ARQUIVO, { force: true })
    fs.rmSync(CONFIG, { force: true })
  } catch (erro) {
    vscode.window.showErrorMessage(
      `Não foi possível remover o plugin do Claude Code: ${erro.message}\n` +
        'Confira a permissão de escrita na pasta ~/.claude e tente de novo.',
    )
    return
  }
  atualizar()
  vscode.window.showInformationMessage('Plugin removido.\nA previsão some a partir da próxima sessão do Claude Code.')
}

function observar() {
  try {
    fs.mkdirSync(PASTA_DADOS, { recursive: true })
    observador = fs.watch(PASTA_DADOS, (evento, nome) => {
      if (nome !== 'previsao.json') return
      clearTimeout(espera)
      // O plugin grava o arquivo inteiro de uma vez; espera um instante para não ler pela metade
      espera = setTimeout(atualizar, 300)
    })
  } catch {
    observador = undefined
  }
}

function lerPrevisao() {
  const previsao = lerJson(ARQUIVO)
  return previsao && Array.isArray(previsao.limites) ? previsao : null
}

function horaCurta(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// A previsão aparece no painel do Claude Code, pelo plugin; a barra de status do VS Code é opcional
function barraLigada() {
  return vscode.workspace.getConfiguration('tokenometro').get('barraDeStatus', false)
}

function atualizar() {
  if (!barraLigada()) {
    item.hide()
    return
  }
  const previsao = lerPrevisao()
  const agora = Date.now()
  item.backgroundColor = undefined
  if (!previsao) {
    const instalado = pluginInstalado()
    item.text = '$(pulse) Tokenômetro: aguardando leitura'
    item.tooltip = instalado
      ? 'A previsão aparece depois da próxima resposta do Claude Code.'
      : 'Clique para instalar o plugin do Claude Code que calcula a previsão.'
    item.command = instalado ? 'tokenometro.mostrarDetalhes' : 'tokenometro.instalarPlugin'
    item.show()
    return
  }
  item.command = 'tokenometro.mostrarDetalhes'
  // Leitura antiga, ou algum limite já renovou desde ela: a previsão gravada não vale mais
  const antiga = agora - previsao.atualizadoEm > VALIDADE_MS || previsao.limites.some(l => l.resetsAt <= agora)
  if (antiga) {
    item.text = '$(history) Tokenômetro: sem leitura recente'
  } else if (previsao.emRisco) {
    item.text = `$(warning) ${String(previsao.linha || '').replace(/^⚠\s*/, '')}`
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  } else {
    item.text = `$(check) ${previsao.linha || 'Uso de tokens dentro dos limites'}`
  }
  item.tooltip = montarDica(previsao, antiga)
  item.show()
}

function montarDica(previsao, antiga) {
  const dica = new vscode.MarkdownString()
  dica.appendMarkdown('**Previsão de uso do Claude Code**\n\n')
  for (const limite of previsao.limites) {
    dica.appendText(limite.detalhe)
    dica.appendMarkdown('\n\n---\n\n')
  }
  const quando = `Atualizado às ${horaCurta(previsao.atualizadoEm)}`
  dica.appendMarkdown(antiga ? `_${quando}. Envie uma mensagem ao Claude Code para atualizar._` : `_${quando}_`)
  return dica
}

async function mostrarDetalhes() {
  const previsao = lerPrevisao()
  if (!previsao) {
    vscode.window.showInformationMessage(
      pluginInstalado()
        ? 'Ainda não há leitura do limite.\nEla chega com a próxima resposta do Claude Code.'
        : 'O plugin do Claude Code que calcula a previsão não está instalado.\nRode o comando "Tokenômetro: Instalar plugin no Claude Code".',
    )
    return
  }
  vscode.window.showInformationMessage(previsao.linha || 'Uso de tokens dentro dos limites', {
    modal: true,
    detail: `${previsao.limites.map(l => l.detalhe).join('\n\n')}\n\nAtualizado às ${horaCurta(previsao.atualizadoEm)}.`,
  })
}

module.exports = { activate, deactivate }
