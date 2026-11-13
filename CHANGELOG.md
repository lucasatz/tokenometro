# Alterações

## 0.1.3

- Linha da previsão toda em português: `⚠ 5h: irá esgotar 15:22 (renova 17:00)` e `⚠ 7 dias: irá esgotar qui, 19/11 às 15:00 (renova sex, 20/11 às 00:00)`, com a hora em 24 horas.
- Limite que já acabou aparece como `esgotado`, e a menos de um minuto do fim, como `esgotando agora`. Antes aparecia "irá esgotar soon".
- Opção de idioma: português do Brasil por padrão, ou inglês, pela configuração **Tokenômetro: Idioma** ou pelo comando **Tokenômetro: Mudar idioma**. Em inglês, a linha segue o painel de uso do Claude Code e o comando vira `/limit`.

## 0.1.2

- No terminal, o aviso aparece na faixa logo acima do campo de mensagem, sem o nome do plugin na frente, e só quando um limite vai acabar antes de renovar. Dentro dos limites, o estado fica discreto no fim da linha de dicas, abaixo do campo.
- O `/limite` mostra o detalhe na conversa e não abre mais o painel. No terminal em tela cheia, o painel ocupava uma coluna inteira ao lado da conversa.
- Quando o painel é aberto pela opção de abrir ao iniciar, ele pede só o espaço da linha: uma linha de altura acima do campo de mensagem ou uma coluna estreita, com a linha quebrada, ao lado da conversa.

## 0.1.1

- Descrição revista.
- README mais completo: o nome que aparece antes da linha de previsão, o painel aberto pelo `/limite`, o link de instalação, onde relatar problemas e a licença.
- Categoria AI no Marketplace.

## 0.1.0

- Primeira versão.
- Previsão dos limites de 5 horas e semanal no painel do Claude Code, com aviso quando um limite vai acabar antes de renovar e detalhe pelo comando `/limite`.
- Instalação do plugin do Claude Code pela própria extensão, com cópia de segurança do `settings.json`.
- Opção de abrir o painel do Tokenômetro ao iniciar a sessão, desligada por padrão.
- Barra de status do VS Code opcional.
