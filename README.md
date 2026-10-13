<h1 align="center">mono</h1>

<p align="center">
  Cliente de APIs <b>REST e SOAP</b> para Windows, minimalista e em preto e branco.<br>
  Inspirado no Postman, com o que faltava para quem trabalha com APIs no Brasil:<br>
  certificado digital A1, webservices da SEFAZ e assinatura de XML.
</p>

<p align="center">
  <a href="https://github.com/jordaoluiz/mono/releases/latest"><b>⬇ Baixar o instalador</b></a> ·
  <a href="#começando">Começando</a> ·
  <a href="#recursos">Recursos</a> ·
  <a href="#desenvolvimento">Desenvolvimento</a>
</p>

![Tela principal do Mono](docs/screenshots/00-principal.png)

---

## Sumário

- [Por que o Mono](#por-que-o-mono)
- [Começando](#começando)
- [Recursos](#recursos)
  - [Importar uma API pela documentação](#importar-uma-api-pela-documentação)
  - [Visão geral da API, com diagramas](#visão-geral-da-api-com-diagramas)
  - [Variáveis e ambientes](#variáveis-e-ambientes)
  - [Scripts e testes (API pm.* do Postman)](#scripts-e-testes-api-pm-do-postman)
  - [Collection Runner com CSV](#collection-runner-com-csv)
  - [Comparar ambientes](#comparar-ambientes)
  - [Gerar tipos e gerar código](#gerar-tipos-e-gerar-código)
  - [Corpo da requisição](#corpo-da-requisição)
  - [SOAP, SEFAZ e certificado digital](#soap-sefaz-e-certificado-digital)
  - [Assinatura digital de XML](#assinatura-digital-de-xml)
  - [Trava de produção](#trava-de-produção)
  - [Proxy corporativo, temas e o resto](#proxy-corporativo-temas-e-o-resto)
- [Atalhos](#atalhos)
- [Desenvolvimento](#desenvolvimento)
- [Publicar uma versão](#publicar-uma-versão)
- [Arquitetura e segurança](#arquitetura-e-segurança)

---

## Por que o Mono

| | Postman | Mono |
|---|---|---|
| Conta e nuvem | Login obrigatório para a maioria dos recursos | Nada sai do seu computador; dados em `%APPDATA%\Mono` |
| Importar API | OpenAPI e coleções | OpenAPI, Swagger UI, Redoc, apiDoc, Postman, **WSDL** e texto livre (com IA) |
| Entender uma API nova | Ler a documentação | **Visão geral** gerada: para que serve, como usar, diagramas e variáveis |
| SOAP | Corpo cru, sem WSDL | **Importa WSDL** e monta os envelopes; modelos da SEFAZ |
| Certificado A1 (.pfx) | Por host, sem suporte a .pfx antigos | Por host, inclusive `.pfx` antigos (RC2) exportados pelo Windows |
| Assinar XML (NF-e, eventos) | Não tem | **XMLDSig** no padrão fiscal, no botão ou por script |
| Ambientes | Variáveis | Variáveis, **comparação lado a lado** e **trava de produção** |
| Tipos e código | Snippets de código | Snippets + **records C# / TypeScript / Zod** a partir da resposta |
| Contrato | — | Avisa quando a resposta **muda de estrutura** ou foge do OpenAPI |

---

## Começando

### Instalar

1. Baixe o `Mono-Setup-x.y.z.exe` em [Releases](https://github.com/jordaoluiz/mono/releases/latest).
2. Execute. Como o instalador ainda não é assinado digitalmente, o Windows SmartScreen pode avisar: clique em **Mais informações › Executar assim mesmo**.
3. O Mono cria atalhos no menu Iniciar e na área de trabalho e se atualiza sozinho quando sai uma versão nova.

### Primeira requisição em 1 minuto

1. Clique em **Importar API** (rodapé da barra lateral) e cole `https://restful-booker.herokuapp.com/apidoc/index.html`.
2. O Mono monta a coleção, cria o ambiente com `{{baseUrl}}` e abre a visão geral da API.
3. Abra **Auth › Create Token** e clique em **Enviar** (`Ctrl+Enter`). O token vai sozinho para `{{token}}`.
4. As requisições protegidas já usam o token. É só enviar.

---

## Recursos

### Importar uma API pela documentação

![Importar API](docs/screenshots/01-importar-api.png)

O **Importar API** aceita o link da documentação, um arquivo ou o conteúdo colado, e descobre sozinho onde está a especificação:

- **OpenAPI 3 / Swagger 2** (JSON ou YAML), páginas **Swagger UI** e **Redoc**, e caminhos comuns como `/v3/api-docs` e `/swagger.json`;
- **apiDoc** (`api_data.json`);
- **WSDL** de webservices SOAP (`…/servico.asmx`, `…?wsdl`, `.svc`);
- **coleções do Postman** (arquivo, link de coleção, documentação publicada ou workspace público) e exportações do Mono;
- documentação em **texto livre**, lida com IA (Claude ou ChatGPT, com a sua chave em *Configurações › IA*).

O resultado é uma coleção com uma pasta por grupo, bodies de exemplo, autenticação configurada e um ambiente com as variáveis. Endpoints de login ganham um script que guarda o token no ambiente.

### Visão geral da API, com diagramas

![Visão geral](docs/screenshots/02-visao-geral.png)

Cada API importada ganha uma **Visão geral** (ícone de livro na coleção):

- para que a API serve e o que dá para fazer com ela;
- passo a passo de uso e como autenticar;
- **diagrama de comunicação** e **fluxo típico** (diagrama de sequência);
- tabela de endpoints (um clique abre a requisição);
- variáveis que a coleção usa, com botão para **criá-las no ambiente**;
- relatório da importação: origem, o que foi criado e onde o Mono procurou.

Exporta em HTML ou Markdown, e cada diagrama copia como SVG.

![Diagramas](docs/screenshots/03-diagramas.png)

![Como usar e variáveis](docs/screenshots/04-como-usar-variaveis.png)

### Variáveis e ambientes

`{{variáveis}}` aparecem em **azul** quando existem e em **vermelho** quando não existem. Passe o mouse para ver o valor, ou clique para editar ou criar a variável no ambiente, na coleção ou nas globais.

![Balão de variável](docs/screenshots/05-variavel-balao.png)

Ao digitar `{{` na URL, nos params ou nos headers, abre o autocompletar com o escopo e o valor de cada variável. `{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}` e outras variáveis dinâmicas aparecem com `{{$`.

![Autocompletar](docs/screenshots/06-autocompletar.png)

- **Escopos:** globais › coleção › ambiente › variáveis do script (a mais específica vence).
- **Segredos:** variáveis marcadas como segredo (cadeado) são criptografadas no disco pelo Windows (DPAPI) e nunca vão para exportações.

### Scripts e testes (API pm.* do Postman)

![Scripts e testes](docs/screenshots/09-scripts-testes.png)

A aba **Scripts** tem *Antes da requisição* e *Após a resposta*, com a mesma API do Postman: `pm.test`, `pm.expect` (estilo Chai), `pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.variables`, `pm.request` (alterável antes do envio), `pm.response`, `pm.sendRequest`, `pm.cookies`, `pm.visualizer` e `pm.execution`.

- O editor tem números de linha, cores, autocompletar de `pm.` e `Ctrl+/` para comentar.
- **Snippets** prontos e uma **Referência** da API ficam no canto do editor.
- Coleções e pastas também têm scripts. A ordem de execução é coleção › pastas › requisição.
- Os resultados aparecem nas abas **Testes**, **Console** e **Visualizar** da resposta. Erro no script mostra a linha.
- Os scripts rodam isolados num Web Worker, sem acesso ao app nem aos seus arquivos.

![Snippets](docs/screenshots/10-snippets.png)

### Collection Runner com CSV

![Runner: configuração](docs/screenshots/12-runner-config.png)

Menu ⋯ da coleção › **Executar coleção** (ou de uma pasta). Escolha as requisições, a ordem, as iterações e um **arquivo de dados** CSV (aceita `;` do Excel) ou JSON. Cada linha vira uma iteração e cada coluna vira `{{variável}}` e `pm.iterationData`.

![Runner: resultado](docs/screenshots/13-runner-resultado.png)

- O resultado mostra requisições, testes que passaram e falharam, erros e tempo médio, com filtro "Só falhas".
- Clicando numa linha aparecem os testes, o console e a resposta.
- `pm.execution.setNextRequest()` muda a ordem da execução.
- O relatório exporta em HTML ou JSON.

### Comparar ambientes

![Comparar ambientes](docs/screenshots/08-comparar-ambientes.png)

O botão **Comparar** envia a mesma requisição para dois ambientes ao mesmo tempo (ex.: produção × homologação) e mostra lado a lado o status, o tempo e cada diferença no JSON: valor, tipo, campo que só existe de um lado. Dá para ignorar campos voláteis como `timestamp`.

O Mono também guarda a estrutura da última resposta de cada endpoint e avisa em **Mudanças** quando aparece campo novo, some um campo ou muda um tipo. Com OpenAPI, a resposta é validada contra o contrato (selo **Contrato**).

### Gerar tipos e gerar código

![Gerar tipos](docs/screenshots/07-gerar-tipos.png)

**Gerar tipos** transforma a resposta JSON em `record` C# (com `JsonPropertyName`), `interface` TypeScript ou schema Zod. Detecta campos opcionais, nulos, datas ISO e GUIDs.

![Gerar código](docs/screenshots/11-gerar-codigo.png)

**</> Código** gera a requisição em **cURL, C# (HttpClient), JavaScript (fetch e axios), Python (requests) e Power Automate** (ação HTTP).

- Inclui headers, corpo (até form-data e arquivos), a autorização herdada da pasta ou coleção e o certificado digital do host.
- No C#, pode incluir os records da última resposta e desserializar direto neles.

### Corpo da requisição

![Corpo JSON](docs/screenshots/14-body-json.png)

O seletor de tipo oferece JSON, XML / SOAP, texto, **form-data** (campos e arquivos), x-www-form-urlencoded e **binário** (um arquivo como corpo). O editor é o mesmo dos scripts, com linhas e cores.

Arquivos são lidos na hora do envio, e só os que você escolheu na janela do Windows. Uma coleção importada não consegue fazer o app enviar outros arquivos do seu computador.

### SOAP, SEFAZ e certificado digital

![SOAP com a SEFAZ](docs/screenshots/15-soap-sefaz.png)

- **Importar WSDL:** cole o link do `.asmx`. O Mono busca o `?wsdl` e os XSD, cria uma requisição por operação e monta o envelope (SOAP 1.1 ou 1.2) com Content-Type e SOAPAction certos.
- **Mensagens da NF-e:** nos serviços da NF-e 4.00 (status, consulta de protocolo, eventos, inutilização, cadastro, autorização), o corpo já vem com a mensagem de exemplo.
- **Modelos SOAP:** envelopes 1.1 e 1.2 e o *Status do Serviço* da SEFAZ ficam no botão **Modelos SOAP** do Body.

![Certificados](docs/screenshots/17-certificados.png)

Em **Configurações › Certificados**, cadastre o `.pfx` (A1) para um host, como `*.fazenda.sp.gov.br`. As requisições HTTPS para ele usam o certificado automaticamente (mTLS), inclusive o download do WSDL.

- Mostra o titular e a validade, com aviso perto do vencimento. A senha fica criptografada.
- Lê `.pfx` modernos (AES), 3DES e os antigos com RC2, comuns em certificados exportados pelo Windows.
- "CA do servidor" serve para cadeias ICP-Brasil que não forem reconhecidas.
- Funciona atrás do proxy HTTP da empresa.

### Assinatura digital de XML

![Assinar XML](docs/screenshots/16-assinar-xml.png)

O botão **Assinar** (Body do tipo XML) aplica a assinatura **XMLDSig enveloped** no padrão dos documentos fiscais: C14N, `Reference URI="#Id"` e certificado no `KeyInfo`.

- **Algoritmo:** RSA-SHA1 para NF-e, NFC-e, CT-e e MDF-e; RSA-SHA256 para eSocial, Reinf e algumas NFS-e.
- **Elemento:** o Mono sugere o elemento a assinar (`infNFe`, `infEvento`, `infInut`…) e assina todos os do lote.
- **Formatação:** é removida antes de assinar, porque a SEFAZ rejeita quebras de linha entre as tags.
- **Envelope SOAP:** quando o XML está dentro dele, só o documento fiscal entra na assinatura.
- **Verificar** confere as assinaturas.
- **Por script:** `await pm.xml.sign(pm.request.body.raw, 'infEvento')` assina antes de cada envio.

### Trava de produção

![Trava de produção](docs/screenshots/19-trava-producao.png)

Marque um ambiente como **produção**. O app mostra uma faixa de aviso, e POST, PUT, PATCH e DELETE pedem confirmação com a URL final. Vale também para o Runner.

### Proxy corporativo, temas e o resto

![Proxy](docs/screenshots/18-proxy.png)

- **Proxy:** do sistema (PAC/WPAD), personalizado (HTTP, HTTPS, SOCKS5, com usuário e senha) ou nenhum, com botão de teste.
- **Requisições:** tempo limite, redirecionamentos e verificação SSL.
- **Autorização** no padrão do Postman: herdar do pai, Bearer, Basic, API Key e OAuth 2.0 (client credentials e password, com renovação automática). Coleções e pastas têm a própria autorização.
- **Organização:** pastas e subpastas com arrastar e soltar, histórico por dia e abas.
- **Exportar:** coleção no formato Mono, Postman v2.1 ou OpenAPI. Segredos nunca são exportados.
- **Resposta:** *Pretty* e *Raw* com detecção de linguagem (JSON, HTML, XML…), **Preview** de HTML e imagens, e resposta embaixo ou ao lado.
- **cURL:** colar um `curl` na barra de URL monta a requisição.
- **Temas:** escuro, claro e azul.

![Temas: escuro, claro e azul](docs/screenshots/20-temas.png)

---

## Atalhos

| Atalho | Ação |
|---|---|
| `Ctrl+Enter` | Enviar |
| `Ctrl+S` | Salvar requisição |
| `Ctrl+T` / `Ctrl+W` | Nova aba / fechar aba |
| `Ctrl+Alt+L` | Resposta embaixo ou ao lado |
| `{{` | Autocompletar variáveis |
| `Ctrl+Espaço` | Autocompletar no editor de scripts |
| `Ctrl+/` | Comentar linhas no editor |

---

## Desenvolvimento

Requisitos: Windows, [Node.js](https://nodejs.org) 20+ e Git.

```powershell
git clone https://github.com/jordaoluiz/mono.git
cd mono
npm.cmd install
npm.cmd run dev
```

`npm run dev` liga o **hot reload**: mudanças na interface recarregam a janela (CSS sem recarregar) e mudanças no processo principal reiniciam o app.

| Comando | O que faz |
|---|---|
| `npm.cmd start` | Abre o app |
| `npm.cmd run dev` | Abre com hot reload |
| `npm.cmd test` | Roda os testes (HTTP, scripts, importação, WSDL, assinatura, certificados…) |
| `npm.cmd run dist` | Gera o instalador em `dist\Mono-Setup-<versão>.exe` |

> No PowerShell use `npm.cmd`/`npx.cmd`: a política de execução padrão bloqueia os atalhos `.ps1`.

### Estrutura

```
src/
  main.js            processo principal: janela, IPC, arquivos, IA
  http.js            monta e envia requisições (body, auth, multipart…)
  network.js         sessão do Chromium com proxy e SSL
  certs.js           mTLS com .pfx (A1) e túnel pelo proxy
  pkcs12.js rc2.js   leitura de .pfx (inclusive RC2)
  xmlsign.js         assinatura XMLDSig
  updater.js         atualização automática
  store.js           dados em disco, segredos via safeStorage
  preload.js         ponte mínima entre interface e processo principal
  shared/            módulos sem dependências, usados na interface e nos testes
                     (OpenAPI, apiDoc, Postman, WSDL, XML/C14N, scripts pm.*, codegen, runner…)
  renderer/          interface (HTML, CSS do design system, editor de scripts, variáveis)
test/                testes em Node, sem frameworks
```

O visual segue o design system descrito em [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md).

---

## Publicar uma versão

```powershell
npm.cmd version patch      # 0.1.1 → 0.1.2, cria o commit e a tag
git push --follow-tags
```

O GitHub Actions (`.github/workflows/release.yml`) roda os testes, gera o instalador e publica em [Releases](https://github.com/jordaoluiz/mono/releases). Os apps instalados procuram atualização ao abrir e a cada 4 horas, baixam em segundo plano e mostram o botão **Atualizar** no topo. *Configurações › Sobre* mostra a versão e procura na hora.

---

## Arquitetura e segurança

- **Requisições no processo principal:** sem CORS. Saem por uma sessão própria do Chromium que respeita proxy e SSL. Hosts com certificado A1 usam o `https` do Node.
- **Interface isolada:** `contextIsolation` e `sandbox: true`, ponte `contextBridge` com funções explícitas, checagem do remetente em todo IPC e CSP restrita.
- **Scripts:** rodam num Web Worker sem acesso ao app. `pm.sendRequest` e `pm.xml.sign` passam por funções controladas.
- **Preview de HTML:** usa um protocolo próprio (`mono-preview://`) com scripts e formulários bloqueados.
- **Segredos:** variáveis de segredo, senhas de proxy e de certificado e chaves de IA ficam criptografadas com o `safeStorage` (DPAPI no Windows).
- **Arquivos:** só são lidos os que você escolheu na janela do sistema. Coleções importadas não apontam para arquivos do seu computador.
- **Dados:** ficam em `%APPDATA%\Mono\mono-data.json`. Nada é enviado para servidores do Mono, porque eles não existem.

---

<p align="center"><sub>Feito por <a href="https://github.com/jordaoluiz">Luiz Jordão</a> · MIT</sub></p>
