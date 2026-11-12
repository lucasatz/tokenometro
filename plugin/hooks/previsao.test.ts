import { expect, test } from 'claude-code/testing'

import {
  DENTRO_DOS_LIMITES,
  type Previsao,
  criarPesos,
  lerFormato,
  nomeLimite,
  prever,
  registrarAmostra,
  registrarAtividade,
  temFolga,
  textoAviso,
  textoDetalhe,
  textoStatus,
  vaiEsgotar,
} from './previsao'

const MIN = 60_000
const HORA = 60 * MIN
const DIA = 24 * HORA
// Quinta-feira, 12/11/2026, 14:00 no fuso da máquina
const QUI_14H = new Date(2026, 10, 12, 14, 0).getTime()
// Semana do limite de segunda 09/11 00:00 a segunda 16/11 00:00
const SEG_00H = new Date(2026, 10, 9, 0, 0).getTime()
const RENOVA_SEMANA = SEG_00H + 7 * DIA

test('5 horas: com uso agora, o ritmo recente diz a hora em que esgota', async () => {
  const perfil = registrarAtividade(undefined, QUI_14H)
  const pts = [
    { t: QUI_14H - 30 * MIN, p: 45 },
    { t: QUI_14H, p: 60 },
  ]
  const p = prever('five_hour', 60, QUI_14H + 3 * HORA, QUI_14H, pts, perfil)
  expect(p.ritmoPorHora).toBe(30)
  expect(p.origem).toBe('recente')
  // 14h-15h conta inteira (uso agora): 90%; depois 0,9 x 30 por hora: os 10% restantes em 22 minutos
  expect(p.esgotaEm).toBe(QUI_14H + HORA + (10 / 27) * HORA)
  expect(textoStatus([p], QUI_14H)).toBe('⚠ 5hr: irá esgotar 3:22 PM (Resets 5:00 PM)')
})

test('semana: o fim de semana não entra na conta', async () => {
  const sexta17h = new Date(2026, 10, 13, 17, 0).getTime()
  const p = prever('seven_day', 40, RENOVA_SEMANA, sexta17h, [])
  // Pela média de relógio daria cerca de 60%; contando só as horas de uso, quase nada mais é gasto até segunda
  expect((p.pctNaRenovacao ?? 0) < 45).toBe(true)
  expect(temFolga(p)).toBe(true)
  expect(textoStatus([p], sexta17h)).toBe(DENTRO_DOS_LIMITES)
})

test('semana: quando esgota, esgota dentro do horário de uso', async () => {
  const quarta18h = new Date(2026, 10, 11, 18, 0).getTime()
  const p = prever('seven_day', 85, RENOVA_SEMANA, quarta18h, [])
  expect(vaiEsgotar(p)).toBe(true)
  const fim = new Date(p.esgotaEm ?? 0)
  expect(fim.getDay()).toBe(4)
  expect(fim.getHours() >= 8 && fim.getHours() < 18).toBe(true)
  expect(textoStatus([p], quarta18h)?.startsWith('⚠ 7 day: irá esgotar Thu, Nov 12 at ')).toBe(true)
  expect(textoStatus([p], quarta18h)?.endsWith(' (Resets Mon, Nov 16 at 12:00 AM)')).toBe(true)
  // O aviso na tela fica em português, no formato aprovado
  expect(textoAviso(p, quarta18h).startsWith('Atenção: se continuar nesse ritmo, o limite semanal irá esgotar amanhã às ')).toBe(true)
  expect(textoAviso(p, quarta18h)).toContain('Ele só renova segunda, 16/11, às 00h00.')
  expect(textoDetalhe(p, quarta18h)).toContain('Para chegar até a renovação, use até ')
})

test('semana recém-começada usa o ritmo da semana anterior', async () => {
  const seg02h = SEG_00H + 2 * HORA
  const sem = prever('seven_day', 1, RENOVA_SEMANA, seg02h, [])
  expect(sem.ritmoPorHora).toBe(null)
  expect(textoStatus([sem], seg02h)).toBe(DENTRO_DOS_LIMITES)
  // Cerca de 48 horas de uso na semana: a 3% por hora de uso, esgota antes de renovar
  const com = prever('seven_day', 1, RENOVA_SEMANA, seg02h, [], undefined, 3)
  expect(com.origem).toBe('anterior')
  expect(textoStatus([com], seg02h)?.startsWith('⚠ 7 day: irá esgotar ')).toBe(true)
})

test('a linha mostra só os limites que esgotam, em ordem fixa', async () => {
  const base = { pct: 50, horasRestantes: 10, origem: 'janela' as const, ritmoPorHora: 5, pctNaRenovacao: 120 }
  const cinco: Previsao = { ...base, kind: 'five_hour', resetsAt: QUI_14H + HORA, esgotaEm: QUI_14H + 30 * MIN }
  const semana: Previsao = {
    ...base,
    kind: 'seven_day',
    resetsAt: RENOVA_SEMANA,
    esgotaEm: new Date(2026, 10, 13, 10, 0).getTime(),
  }
  expect(textoStatus([semana, cinco], QUI_14H)).toBe(
    '⚠ 5hr: irá esgotar 2:30 PM (Resets 3:00 PM) | ' +
      '7 day: irá esgotar Fri, Nov 13 at 10:00 AM (Resets Mon, Nov 16 at 12:00 AM)',
  )
  const semanaOk: Previsao = { ...semana, esgotaEm: null, pctNaRenovacao: 70 }
  expect(textoStatus([semanaOk, cinco], QUI_14H)).toBe('⚠ 5hr: irá esgotar 2:30 PM (Resets 3:00 PM)')
  expect(textoStatus([semanaOk], QUI_14H)).toBe(DENTRO_DOS_LIMITES)
})

test('limite semanal do Fable entra com o nome do painel', async () => {
  expect(nomeLimite('seven_day_overage_included')).toBe('Fable limit')
  const quarta18h = new Date(2026, 10, 11, 18, 0).getTime()
  const p = prever('seven_day_overage_included', 85, RENOVA_SEMANA, quarta18h, [])
  expect(vaiEsgotar(p)).toBe(true)
  expect(textoStatus([p], quarta18h)?.startsWith('⚠ Fable limit: irá esgotar Thu, Nov 12 at ')).toBe(true)
  expect(textoAviso(p, quarta18h)).toContain('o limite semanal do Fable irá esgotar amanhã às ')
})

test('segue o timeFormat e o timeZone do Claude Code, como o painel de uso', async () => {
  const perfil = registrarAtividade(undefined, QUI_14H)
  const pts = [
    { t: QUI_14H - 30 * MIN, p: 45 },
    { t: QUI_14H, p: 60 },
  ]
  const p = prever('five_hour', 60, QUI_14H + 3 * HORA, QUI_14H, pts, perfil)
  expect(textoStatus([p], QUI_14H, lerFormato('24-hour', 'America/Sao_Paulo'))).toBe(
    '⚠ 5hr: irá esgotar 15:22 (Resets 17:00)',
  )
  expect(textoStatus([p], QUI_14H, lerFormato('%H:%M', undefined))).toBe('⚠ 5hr: irá esgotar 15:22 (Resets 17:00)')
  // Fuso que não existe cai no fuso do sistema, como no Claude Code
  expect(textoStatus([p], QUI_14H, lerFormato('12-hour', 'Fuso/Inexistente'))).toBe(
    '⚠ 5hr: irá esgotar 3:22 PM (Resets 5:00 PM)',
  )
  const utc = String(new Date(QUI_14H + 3 * HORA).getUTCHours()).padStart(2, '0')
  expect(textoStatus([p], QUI_14H, lerFormato('24-hour-utc', undefined))?.endsWith(`(Resets ${utc}:00Z)`)).toBe(true)
})

test('o horário aprendido passa a valer: sábado de uso conta', async () => {
  const desde = QUI_14H - 21 * DIA
  let perfil = registrarAtividade(undefined, desde)
  for (const semana of [0, 1, 2]) {
    const sabado10h = new Date(2026, 9, 24 + semana * 7, 10, 0).getTime()
    perfil = registrarAtividade(perfil, sabado10h)
  }
  const pesos = criarPesos(perfil, QUI_14H)
  expect(pesos(new Date(2026, 10, 14, 10, 0).getTime()) > 0.8).toBe(true)
  expect(pesos(new Date(2026, 10, 14, 3, 0).getTime()) < 0.1).toBe(true)
})

test('renovação nova descarta as leituras da janela anterior', async () => {
  const antiga = { kind: 'five_hour', resetsAt: QUI_14H - HORA, pts: [{ t: QUI_14H - 2 * HORA, p: 90 }] }
  const nova = registrarAmostra(antiga, 'five_hour', QUI_14H + 4 * HORA, QUI_14H, 5)
  expect(nova.pts.length).toBe(1)
  expect(nova.pts[0]?.p).toBe(5)
  const repetida = registrarAmostra(nova, 'five_hour', QUI_14H + 4 * HORA, QUI_14H + MIN, 5)
  expect(repetida.pts.length).toBe(1)
})
