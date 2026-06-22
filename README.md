# Bet365 Data Extractor

Extensão Chrome e scripts de console para extrair **placar, relógio, estatísticas e odds** de jogos na Bet365, com exportação em ZIP para diagnóstico.

**Versão atual:** 3.10.1

## O que extrai

| Dado | Fonte principal |
|------|-----------------|
| Placar e relógio | DOM do painel lateral (`dom-scoreboard`) |
| Estatísticas | Texto colado da aba Estat. |
| Odds | DOM dos mercados |
| Rede (diagnóstico) | fetch / XHR / WebSocket (`sportspublisher/zap`, `/Api/1/Blob`) |

O ZIP inclui: `data.json`, `logs.txt`, `debug.txt`, `trace.txt`, `meta.json`.

## Instalação da extensão (Chrome)

1. Clone o repositório e gere os bundles:

```bash
npm run build
```

2. Abra `chrome://extensions`
3. Ative **Modo do desenvolvedor**
4. **Carregar sem compactação** → pasta `extension/`
5. Recarregue a extensão após cada `npm run build`

## Uso

1. Abra um jogo na Bet365:
   - **Ao vivo:** URL com `#/IP/EV...`
   - **Pré-jogo:** URL com `#/AC/.../E...` (ex.: Nova Zelândia x Egito)
2. Para stats ao vivo, abra a aba **Estat.** na página
3. Clique no ícone da extensão → **Extrair e Baixar ZIP**

Se o download falhar, recarregue a página (F5) depois de recarregar a extensão.

## Console (sem extensão)

Após `npm run build`:

- `bet365-console-extractor.js` — cole no DevTools da aba do jogo
- `index.html` / `index-autorun.html` — página local com o bundle

## Desenvolvimento

```bash
npm test          # 72 testes
npm run build     # console + HTML + extensão
npm run build:extension
```

### Estrutura

```
lib/                 parsers, ZIP, protocolo wire Bet365
templates/           content script, sniffer de rede, console
extension/           manifest MV3, popup, background, dist/
tests/               testes Node (node:test)
scripts/             build-console, build-extension, build-html
```

## URLs suportadas

- `https://www.bet365.bet.br/#/IP/EV151352326532C1/` — in-play
- `https://www.bet365.bet.br/#/AC/B1/C1/D8/E194699812/F3/I1/` — pré-jogo

## Aviso

Ferramenta de extração pessoal/diagnóstico. Respeite os termos de uso da Bet365. Não afiliada à Bet365.