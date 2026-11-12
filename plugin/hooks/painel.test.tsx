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
    value: { value: '⚠ 5h: irá esgotar 10h47 | 7 dias: irá esgotar qua 18/11 15h00', version: 1 },
  }))
  for (const surface of ['vscode', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PAINEL, surface })
    const texto = await ui.find({ type: 'Text' })
    expect(texto?.text).toBe('⚠ 5h: irá esgotar 10h47 | 7 dias: irá esgotar qua 18/11 15h00')
    await ui.unmount()
  }
})

test('sem leitura ainda, o painel diz que está aguardando', async ($, on) => {
  on('state.get', () => ({ value: { value: null, version: 0 } }))
  const ui = await $.ui.mount({ ...PAINEL, surface: 'vscode' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Uso de tokens: aguardando a primeira leitura do limite.')
  await ui.unmount()
})
