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
    vscode.commands.registerCommand('tokenometro.mudarIdioma', mudarIdioma),
  )
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tokenometro.barraDeStatus')) atualizar()
      if (e.affectsConfiguration('tokenometro.abrirPainelAoIniciar')) gravarConfig()
      if (e.affectsConfiguration('tokenometro.idioma')) {
        gravarConfig()
        atualizar()
      }
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

// Português do Brasil é o padrão; o inglês só quando escolhido na configuração tokenometro.idioma
function idioma() {
  return vscode.workspace.getConfiguration('tokenometro').get('idioma', 'pt-BR') === 'en' ? 'en' : 'pt-BR'
}

function t(portugues, ingles) {
  return idioma() === 'en' ? ingles : portugues
}

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

// O plugin roda dentro do Claude Code e não enxerga as configurações do VS Code: recebe as opções por este arquivo
function gravarConfig() {
  const abrirPainel = vscode.workspace.getConfiguration('tokenometro').get('abrirPainelAoIniciar', false)
  try {
    fs.mkdirSync(PASTA_DADOS, { recursive: true })
    fs.writeFileSync(CONFIG, `${JSON.stringify({ abrirPainel, idioma: idioma() }, null, 2)}\n`)
  } catch {
    // Sem permissão de escrita o plugin segue o padrão: painel fechado e textos em português
  }
}

async function mudarIdioma() {
  const opcoes = [
    { label: 'Português (Brasil)', idioma: 'pt-BR' },
    { label: 'English', idioma: 'en' },
  ]
  const escolha = await vscode.window.showQuickPick(opcoes, {
    placeHolder: t('Idioma da previsão no Claude Code', 'Language of the forecast in Claude Code'),
  })
  if (!escolha) return
  await vscode.workspace.getConfiguration('tokenometro').update('idioma', escolha.idioma, vscode.ConfigurationTarget.Global)
  vscode.window.showInformationMessage(
    t(
      'Idioma alterado.\nVale a partir da próxima resposta do Claude Code.',
      'Language changed.\nIt applies from the next Claude Code response.',
    ),
  )
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
    vscode.window.showWarningMessage(
      t(`Não foi possível atualizar o plugin do Claude Code: ${erro.message}`, `Could not update the Claude Code plugin: ${erro.message}`),
    )
  }
}

async function oferecerInstalacao(context) {
  if (pluginInstalado() || context.globalState.get('perguntouInstalacao')) return
  await context.globalState.update('perguntouInstalacao', true)
  await instalarPlugin(context, true)
}

async function instalarPlugin(context, perguntar) {
  if (perguntar) {
    const instalar = t('Instalar', 'Install')
    const resposta = await vscode.window.showInformationMessage(
      t('Para mostrar a previsão, o Tokenômetro instala um plugin no Claude Code.', 'To show the forecast, Tokenômetro installs a plugin in Claude Code.'),
      {
        modal: true,
        detail: t(
          `O plugin é copiado para ${PASTA_PLUGIN} e essa pasta é adicionada em CLAUDE_CODE_PLUGIN_DIRS, no ${SETTINGS}.\n` +
            'Ele começa a valer nas próximas sessões do Claude Code.',
          `The plugin is copied to ${PASTA_PLUGIN} and that folder is added to CLAUDE_CODE_PLUGIN_DIRS, in ${SETTINGS}.\n` +
            'It takes effect in the next Claude Code sessions.',
        ),
      },
      instalar,
    )
    if (resposta !== instalar) return
  }
  const settings = lerSettings()
  if (settings === null) {
    vscode.window.showErrorMessage(
      t(
        `Não foi possível ler o ${SETTINGS}.\nCorrija o arquivo e rode o comando "Tokenômetro: Instalar plugin no Claude Code".`,
        `Could not read ${SETTINGS}.\nFix the file and run the command "Tokenômetro: Instalar plugin no Claude Code".`,
      ),
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
      t(
        `Não foi possível instalar o plugin do Claude Code: ${erro.message}\n` +
          'Confira a permissão de escrita na pasta ~/.claude e rode o comando "Tokenômetro: Instalar plugin no Claude Code".',
        `Could not install the Claude Code plugin: ${erro.message}\n` +
          'Check write permission on the ~/.claude folder and run the command "Tokenômetro: Instalar plugin no Claude Code".',
      ),
    )
    return
  }
  atualizar()
  vscode.window.showInformationMessage(
    t(
      'Plugin instalado.\nAbra uma nova sessão do Claude Code para a previsão começar a aparecer.',
      'Plugin installed.\nOpen a new Claude Code session for the forecast to start showing.',
    ),
  )
}

function gravarSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.tokenometro.bak`)
  fs.writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`)
}

async function removerPlugin() {
  const remover = t('Remover', 'Remove')
  const resposta = await vscode.window.showWarningMessage(
    t('Remover o plugin do Claude Code?', 'Remove the Claude Code plugin?'),
    {
      modal: true,
      detail: t(
        'A previsão deixa de ser calculada a partir da próxima sessão do Claude Code.',
        'The forecast stops being calculated from the next Claude Code session.',
      ),
    },
    remover,
  )
  if (resposta !== remover) return
  const settings = lerSettings()
  if (settings === null) {
    vscode.window.showErrorMessage(
      t(`Não foi possível ler o ${SETTINGS}.\nCorrija o arquivo e tente de novo.`, `Could not read ${SETTINGS}.\nFix the file and try again.`),
    )
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
      t(
        `Não foi possível remover o plugin do Claude Code: ${erro.message}\nConfira a permissão de escrita na pasta ~/.claude e tente de novo.`,
        `Could not remove the Claude Code plugin: ${erro.message}\nCheck write permission on the ~/.claude folder and try again.`,
      ),
    )
    return
  }
  atualizar()
  vscode.window.showInformationMessage(
    t('Plugin removido.\nA previsão some a partir da próxima sessão do Claude Code.', 'Plugin removed.\nThe forecast disappears from the next Claude Code session.'),
  )
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
  return new Date(ms).toLocaleTimeString(idioma() === 'en' ? 'en-US' : 'pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function dentroDosLimites() {
  return t('Uso de tokens dentro dos limites', 'Token usage within limits')
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
    item.text = t('$(pulse) Tokenômetro: aguardando leitura', '$(pulse) Tokenômetro: waiting for a reading')
    item.tooltip = instalado
      ? t('A previsão aparece depois da próxima resposta do Claude Code.', 'The forecast shows up after the next Claude Code response.')
      : t('Clique para instalar o plugin do Claude Code que calcula a previsão.', 'Click to install the Claude Code plugin that calculates the forecast.')
    item.command = instalado ? 'tokenometro.mostrarDetalhes' : 'tokenometro.instalarPlugin'
    item.show()
    return
  }
  item.command = 'tokenometro.mostrarDetalhes'
  // Leitura antiga, ou algum limite já renovou desde ela: a previsão gravada não vale mais
  const antiga = agora - previsao.atualizadoEm > VALIDADE_MS || previsao.limites.some(l => l.resetsAt <= agora)
  if (antiga) {
    item.text = t('$(history) Tokenômetro: sem leitura recente', '$(history) Tokenômetro: no recent reading')
  } else if (previsao.emRisco) {
    item.text = `$(warning) ${String(previsao.linha || '').replace(/^⚠\s*/, '')}`
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  } else {
    item.text = `$(check) ${previsao.linha || dentroDosLimites()}`
  }
  item.tooltip = montarDica(previsao, antiga)
  item.show()
}

function montarDica(previsao, antiga) {
  const dica = new vscode.MarkdownString()
  dica.appendMarkdown(t('**Previsão de uso do Claude Code**\n\n', '**Claude Code usage forecast**\n\n'))
  for (const limite of previsao.limites) {
    dica.appendText(limite.detalhe)
    dica.appendMarkdown('\n\n---\n\n')
  }
  const quando = t(`Atualizado às ${horaCurta(previsao.atualizadoEm)}`, `Updated at ${horaCurta(previsao.atualizadoEm)}`)
  const pedido = t('Envie uma mensagem ao Claude Code para atualizar.', 'Send a message to Claude Code to refresh.')
  dica.appendMarkdown(antiga ? `_${quando}. ${pedido}_` : `_${quando}_`)
  return dica
}

async function mostrarDetalhes() {
  const previsao = lerPrevisao()
  if (!previsao) {
    vscode.window.showInformationMessage(
      pluginInstalado()
        ? t('Ainda não há leitura do limite.\nEla chega com a próxima resposta do Claude Code.', 'No limit reading yet.\nIt arrives with the next Claude Code response.')
        : t(
            'O plugin do Claude Code que calcula a previsão não está instalado.\nRode o comando "Tokenômetro: Instalar plugin no Claude Code".',
            'The Claude Code plugin that calculates the forecast is not installed.\nRun the command "Tokenômetro: Instalar plugin no Claude Code".',
          ),
    )
    return
  }
  const atualizado = t(`Atualizado às ${horaCurta(previsao.atualizadoEm)}.`, `Updated at ${horaCurta(previsao.atualizadoEm)}.`)
  vscode.window.showInformationMessage(previsao.linha || dentroDosLimites(), {
    modal: true,
    detail: `${previsao.limites.map(l => l.detalhe).join('\n\n')}\n\n${atualizado}`,
  })
}

module.exports = { activate, deactivate }
