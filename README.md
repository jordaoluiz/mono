# Mono

Cliente de API minimalista em preto e branco, feito com Electron.

## Rodar

```powershell
cd Documents\mono
npm.cmd install
npm.cmd start
```

Desenvolvimento com hot reload: `npm.cmd run dev`. Alterações na interface recarregam a janela (CSS é trocado sem recarregar), e alterações no processo principal ou no preload reiniciam o app.

Para rodar os testes do motor HTTP: `npm.cmd test`

## Recursos

- Abas, coleções (renomear, duplicar, excluir) e histórico agrupado por dia.
- Params sincronizados com a URL, headers, body (JSON / texto / form) e auth (Bearer / Basic).
- Ambientes com `{{variaveis}}`. Variáveis marcadas como **segredo** são criptografadas no disco pelo cofre do sistema (DPAPI no Windows).
- Resposta com números de linha e realce de JSON e HTML. A aba **Preview** mostra a página HTML (ou a imagem) renderizada, com scripts e formulários bloqueados.
- Barra de título integrada no Windows: a faixa do topo é a área de arrastar, e os botões nativos seguem o tema.
- Testes por requisição: `test()`, `expect()`, `res.json()`, `log()`. Rodam num Web Worker isolado, com limite de 3 s.
- Colar um comando `curl` na barra de URL importa a requisição. "Copiar cURL" exporta.
- Temas Escuro, Claro e Azul (menu no botão de tema). A resposta pode ficar embaixo ou ao lado da requisição (botão no topo, `Ctrl+Alt+L` ou duplo clique no divisor), e cada orientação lembra o próprio tamanho.
- Atalhos: `Ctrl+Enter` envia, `Ctrl+S` salva, `Ctrl+T` abre nova aba, `Ctrl+W` fecha a aba.

## Diferenciais

- **Comparar ambientes**: o botão *Comparar*, ao lado de *Enviar*, manda a mesma requisição para o ambiente ativo e para outro, ao mesmo tempo, e mostra lado a lado o status, o tempo e o tamanho de cada um, além de cada diferença no JSON (valor, tipo, campo só em um lado, tamanho de lista). Dá para ignorar campos voláteis, como `requestId` e `timestamp`, e filtrar só estrutura ou só valores.
- **Trava de produção**: marque um ambiente como *produção* no editor de ambientes. O app ganha uma faixa de aviso, e POST, PUT, PATCH e DELETE pedem confirmação mostrando a URL final. GET passa direto.
- **Gerar tipos**: o botão *Gerar tipos*, na resposta JSON, gera `record` em C# (com `JsonPropertyName`), `interface` em TypeScript ou schema Zod. Detecta campos opcionais, nulos, datas ISO, GUIDs e números grandes.
- **O que mudou desde a última vez**: cada resposta JSON é comparada com a anterior do mesmo endpoint, no mesmo ambiente e status. Campo novo, campo removido ou tipo alterado aparecem em *Mudanças*, como um alarme de quebra de contrato sem teste nenhum.
- **OpenAPI como fonte da verdade**: cada resposta é validada contra o schema documentado (tipos, obrigatórios, enum, nullable, campos não documentados), e o resultado aparece no selo *Contrato*. *Atualizar do OpenAPI*, no menu da coleção, traz endpoints novos.

## Importar API pela documentação

*Importar API*, no rodapé da barra lateral, aceita a **URL da documentação**, um arquivo ou um texto colado. O Mono descobre sozinho onde está a especificação:

- OpenAPI 3 / Swagger 2 em JSON ou YAML, páginas Swagger UI e Redoc (lê o `url`/`spec-url` da página e tenta os caminhos comuns, como `/v3/api-docs` e `/swagger.json`);
- apiDoc (`api_data.json`), como em `https://restful-booker.herokuapp.com/apidoc/index.html`;
- coleções Postman v2.1 e coleções exportadas pelo Mono.

O resultado:

- **Coleção montada**, com uma pasta por grupo/tag, body de exemplo e autenticação configurada. Endpoints de login ganham um teste `env.set('token', body.token)`, então o token vai para `{{token}}` sozinho. Um ambiente com `baseUrl` e `token` é criado e ativado.
- **Visão geral** (ícone de livro na coleção, ou menu ⋯ › *Visão geral*), que pode ser reaberta a qualquer momento: para que a API serve, o que dá para fazer, como autenticar, passo a passo de uso, **diagrama de comunicação**, **fluxo típico** (diagrama de sequência) a tabela de endpoints (abre a requisição com um clique), as **variáveis** que a coleção usa, com botão para criá-las no ambiente, e o relatório da **importação** (origem, o que foi criado e onde o Mono procurou). Dá para exportar em HTML ou Markdown, e copiar cada diagrama como SVG.
- **IA (opcional)**: em *Configurações › IA*, com uma chave do Claude (Anthropic) ou do ChatGPT (OpenAI), o Mono lê documentações em texto livre que não têm especificação e enriquece a visão geral. A chave fica criptografada no disco.

Links do **postman.com** também funcionam: documentação publicada (`documenter.getpostman.com/view/…`), link de coleção e workspace público. Com uma chave da API do Postman (*Configurações › Postman*) o caminho é o oficial; sem chave, o Mono tenta o mesmo acesso público do site e, se o Postman exigir login, explica como exportar.

## Scripts (como no Postman)

Aba **Scripts** da requisição, com **Antes da requisição** e **Após a resposta**. Coleções e pastas também têm scripts (menu ⋯ › *Scripts…*), e a ordem de execução é coleção → pastas → requisição.

- API `pm.*` do Postman: `pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.variables`, `pm.request` (pode alterar URL, headers e body antes de enviar), `pm.response`, `pm.test`, `pm.expect` (estilo Chai), `pm.sendRequest`, `pm.cookies`, `pm.visualizer`, `pm.execution.skipRequest()`. Também aceita a sintaxe antiga (`postman.setEnvironmentVariable`, `tests[...]`).
- Editor com números de linha, cores, autocompletar de `pm.` (Ctrl+Espaço), Ctrl+/ para comentar, **Snippets** e **Referência**.
- Resultado nas abas **Testes**, **Console** e **Visualizar** da resposta. Erro no script mostra a linha.
- Roda isolado num worker, sem acesso ao app. Variáveis dinâmicas: `{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}`, `{{$randomEmail}}`…
- Variáveis em três escopos além do ambiente: **globais** (Ambientes › Globais) e **da coleção** (menu ⋯ › *Variáveis…*). Prioridade: script › ambiente › coleção › globais.

## Collection Runner

Menu ⋯ da coleção › *Executar coleção…* (ou ⋯ da pasta › *Executar pasta…*). Escolha as requisições e a ordem, o número de iterações e um intervalo entre requisições.

- **Arquivo de dados** CSV (separador `,` `;` ou tab, aspas e quebras de linha) ou JSON (lista de objetos). Cada linha vira uma iteração; as colunas viram `{{variáveis}}` e ficam em `pm.iterationData`.
- Scripts rodam como no envio normal. `pm.execution.setNextRequest("Nome")` muda a ordem, e `setNextRequest(null)` encerra a iteração.
- O resultado mostra requisições, testes que passaram e falharam, erros e tempo médio, com filtro "Só falhas". Clicando numa linha aparecem os testes, o console e a resposta.
- Exporta o relatório em HTML ou JSON. As variáveis que os scripts gravam vão para o ambiente ao final; dá para desligar.
- Em ambiente de produção, pede confirmação antes de executar requisições que alteram dados.

## Corpo da requisição

O tipo do corpo fica num seletor: JSON, **XML / SOAP**, texto, **form-data** (texto e arquivos), x-www-form-urlencoded e **binário** (um arquivo inteiro como corpo). O editor tem números de linha e cores.

- **XML / SOAP**: modelos de envelope SOAP 1.1 e 1.2, e o modelo *SEFAZ · NF-e Status do Serviço 4.00*. O Content-Type é automático (`application/soap+xml` no SOAP 1.2, `text/xml` nos demais) e há um botão para formatar o XML.
- **Arquivos** são lidos do disco na hora do envio. Por segurança, o Mono só lê arquivos escolhidos na janela do sistema neste computador: coleções importadas não conseguem apontar para outros arquivos.

## Certificado digital (mTLS)

*Configurações › Certificados*: cadastre um certificado `.pfx`/`.p12` (ex.: A1 da empresa) para um host (`*.fazenda.sp.gov.br`). As requisições HTTPS para esse host apresentam o certificado automaticamente.

- Mostra o titular e a validade, com aviso perto do vencimento. A senha fica criptografada.
- "CA do servidor" (opcional) serve para cadeias ICP-Brasil que o sistema não reconhece.
- Usa o proxy HTTP do sistema ou o personalizado (túnel CONNECT). Proxy SOCKS não é suportado com certificado.

## Gerar código

O botão **</> Código** gera a requisição atual em cURL, C# (HttpClient), JavaScript (fetch e axios), Python (requests) e Power Automate (ação HTTP).

- Inclui headers, corpo (até form-data e binário), autorização herdada e o certificado digital do host.
- No C#, pode incluir os `record`s gerados a partir da última resposta e desserializar direto neles.
- Dá para gerar com as `{{variáveis}}` resolvidas ou como texto.

## Instalador para Windows e atualização automática

Gerar o instalador local:

```
npm.cmd install
npm.cmd run dist
```

O instalador sai em `dist\Mono-Setup-<versão>.exe`. Ele cria atalhos no menu Iniciar e na área de trabalho, permite escolher a pasta e aparece em "Adicionar ou remover programas". Os dados continuam em `%APPDATA%\Mono` (os mesmos do `npm run dev`).

### Atualização automática (GitHub Releases)

1. No `package.json`, troque `jordaoluiz` (em `repository` e `build.publish`) pelo seu usuário do GitHub e suba o projeto para um repositório **público** chamado `mono`. O atualizador não lê releases de repositório privado sem token.
2. Para publicar uma versão: `npm.cmd version patch` e depois `git push --follow-tags`. O GitHub Actions (`.github/workflows/release.yml`) gera o instalador e publica o release.
3. Os apps instalados procuram atualização ao abrir e a cada 4 horas, baixam em segundo plano e mostram o botão **Atualizar** no topo. *Configurações › Sobre* mostra a versão e permite procurar na hora.

O instalador não é assinado digitalmente. Na primeira execução, o Windows SmartScreen pode avisar: use "Mais informações › Executar assim mesmo". Para tirar o aviso, é preciso um certificado de assinatura de código (Code Signing).

## SOAP: importar WSDL

*Importar API* aceita o link do WSDL (`…/servico.asmx?wsdl`, `…/servico.svc?wsdl`) ou só o `.asmx`/`.svc`, porque o Mono procura o `?wsdl` sozinho. Também aceita o arquivo `.wsdl` ou o conteúdo colado. Os XSD importados são buscados automaticamente.

- Cria uma requisição por operação, com o envelope SOAP montado a partir dos schemas (campos opcionais e repetições indicados em comentários, enumerações com o primeiro valor) e o Content-Type/SOAPAction certos. Quando o serviço oferece SOAP 1.1 e 1.2, usa o 1.2 (padrão da SEFAZ 4.00).
- Nos serviços da NF-e 4.00 (status, consulta de protocolo, eventos, inutilização, consulta cadastro, autorização e retorno), o corpo já vem com a mensagem de exemplo.
- Com o certificado A1 cadastrado para o host, o próprio download do WSDL já usa o certificado (muitos servidores da SEFAZ exigem).

## Assinatura digital de XML (XMLDSig)

No Body do tipo *XML / SOAP*, o botão **Assinar** aplica a assinatura "enveloped" no padrão dos documentos fiscais:

- C14N 1.0, `Reference URI="#Id"`, transformações enveloped + C14N, e o certificado no `KeyInfo`;
- RSA-SHA1 para NF-e, NFC-e, CT-e e MDF-e, ou RSA-SHA256 para eSocial, Reinf e algumas NFS-e;
- o elemento a assinar (`infNFe`, `infEvento`, `infInut`…) é sugerido; todos os que existirem são assinados (lote com várias notas) e a assinatura anterior é substituída;
- remove a formatação antes de assinar, porque a SEFAZ rejeita quebras de linha entre as tags. Com o XML dentro do envelope SOAP, só o documento fiscal entra na assinatura;
- **Verificar** confere as assinaturas do corpo.

Nos scripts, `await pm.xml.sign(xml, 'infEvento')` assina com o certificado configurado para o host da requisição. Há um snippet pronto em "Antes da requisição".

Lê `.pfx` modernos (AES/PBES2), 3DES e os antigos com RC2, comuns em A1 exportados pelo Windows, inclusive no envio com certificado (mTLS).

## Variáveis em destaque

`{{variáveis}}` aparecem em azul na URL, params e headers (vermelho se não existem). Passe o mouse ou clique para ver e editar o valor, ou criar a variável no ambiente, na coleção ou nas globais.

## Exportar

Menu ⋯ da coleção › *Exportar…*: formato Mono (reimportável), Postman v2.1, especificação OpenAPI (quando a coleção veio de uma) ou visão geral em HTML. Valores secretos nunca são exportados.

## Organização e configurações

- **Pastas**: coleções aceitam pastas e subpastas (menu ⋯ › *Nova pasta*). Requisições e pastas podem ser arrastadas entre pastas e coleções, ou movidas por *Mover para…*. O título da requisição mostra o caminho. Importar API cria uma pasta por grupo/tag.
- **Autorização** no padrão do Postman: *Herdar do pai*, *Sem autenticação*, *Bearer Token*, *Basic Auth*, *API Key* (header ou query) e *OAuth 2.0* (client credentials e password, com "Obter novo token" e renovação automática quando expira). Coleções e pastas têm a própria autorização (menu ⋯ › *Autorização…*), e as requisições novas herdam dela.
- **Configurações** (engrenagem no topo), globais do usuário:
  - **Proxy**: do sistema (inclui PAC/WPAD), personalizado (HTTP, HTTPS ou SOCKS5, com usuário e senha para proxy que responde 407 e lista de exceções) ou nenhum. Tem botão para testar a conexão.
  - **Requisições**: tempo limite, seguir redirecionamentos e verificação de certificado SSL.
  - As requisições saem por uma sessão própria do Chromium, então respeitam proxy e certificados. A senha do proxy é criptografada no disco.
- **Resposta**: HTML e XML são indentados automaticamente (*Pretty*/*Raw*), com seletor de linguagem e cores de sintaxe.
- **Design system**: veja `DESIGN-SYSTEM.md`.

## Arquitetura (inspirada na análise do Postman, mas mais enxuta)

| Postman | Mono |
|---|---|
| Runtime separado da interface (`postman-runtime`, workers) | Requisições rodam no processo principal (`src/http.js`), sem CORS |
| `keytar` para guardar segredos | `safeStorage` do Electron (`src/store.js`) |
| `tester_sandbox.html` | `test-worker.js`: Web Worker sem acesso ao app |
| `@electron/remote` (ponte ampla, desaconselhada) | `contextBridge` com 6 funções, `sandbox: true`, checagem do remetente no IPC e CSP restrita |
| Preview em webview | Preview por protocolo próprio (`mono-preview://`) com CSP `script-src 'none'` e iframe em sandbox |
| Geradores de código | Exportar e importar cURL |

Os dados ficam em `%APPDATA%\Mono\mono-data.json`.
