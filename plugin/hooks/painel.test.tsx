import { expect, test } from 'claude-code/testing'

const PAINEL = {
  plugin: 'tokenometro',
  component: 'Pane',
  requestId: 'uso',
  props: {
    title: 'Tokenômetro',
    isFocused: false,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

test('o painel mostra a linha sem nome de plugin, no VS Code e no terminal', async ($, on) => {
  on('state.get', () => ({
    value: { value: '⚠ 5h: irá esgotar 11:40 (renova 13:10)', version: 1 },
  }))
  for (const surface of ['vscode', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PAINEL, surface })
    const texto = await ui.find({ type: 'Text' })
    expect(texto?.text).toBe('⚠ 5h: irá esgotar 11:40 (renova 13:10)')
    await ui.unmount()
  }
})

const FAIXA = {
  plugin: 'tokenometro',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const DICA = {
  plugin: 'tokenometro',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

test('no terminal, o aviso aparece na faixa acima do prompt', async ($, on) => {
  on('ui.status', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: '⚠ 5h: irá esgotar 11:40 (renova 13:10)', version: 1 } }))
  const ui = await $.ui.mount({ ...FAIXA, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('⚠ 5h: irá esgotar 11:40 (renova 13:10)')
  await ui.unmount()
})

test('fora do terminal a faixa não é usada: a previsão fica na linha de status', async ($, on) => {
  let status: string | undefined = 'sem chamada'
  on('ui.status', (_, e) => {
    status = e.text
    return { value: undefined }
  })
  on('state.get', () => ({ value: { value: '⚠ 5h: irá esgotar 11:40 (renova 13:10)', version: 1 } }))
  for (const surface of ['vscode', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...FAIXA, surface })
    expect(await ui.find({ type: 'Text', text: /irá esgotar/ })).toBeUndefined()
    await ui.unmount()
  }
  expect(status).toBe('sem chamada')
})

test('no terminal, dentro dos limites a faixa fica livre', async ($, on) => {
  on('ui.status', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: 'Uso de tokens dentro dos limites', version: 1 } }))
  const faixa = await $.ui.mount({ ...FAIXA, surface: 'terminal' })
  expect(await faixa.find({ type: 'Text', text: /Uso de tokens/ })).toBeUndefined()
  await faixa.unmount()
})

test('no terminal, dentro dos limites o estado vai para o fim da dica abaixo do prompt', async ($, on) => {
  on('ui.status', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: 'Uso de tokens dentro dos limites', version: 1 } }))
  // A dica é desenhada pelo próprio Claude Code: confere o texto que o plugin pede para ele acrescentar
  let acrescimo: string | undefined
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    acrescimo = e.props.tail
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  const dica = await $.ui.mount({ ...DICA, surface: 'terminal' })
  expect(acrescimo).toBe('· Uso de tokens dentro dos limites')
  await dica.unmount()
})

test('sem leitura ainda, o painel diz que está aguardando', async ($, on) => {
  on('state.get', () => ({ value: { value: null, version: 0 } }))
  const ui = await $.ui.mount({ ...PAINEL, surface: 'vscode' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Uso de tokens: aguardando a primeira leitura do limite.')
  await ui.unmount()
})
