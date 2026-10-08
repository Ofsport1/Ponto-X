# WhatsApp automático da Ponto X no PC da loja (passo a passo)

## Como funciona (em 30 segundos)

O site avisa o cliente pelo WhatsApp quando o pedido muda de etapa (aceito, saiu para entrega...). Para isso, um programinha fica ligado no PC da loja, conectado ao WhatsApp do "número do robô". O site conversa com esse programa por um túnel gratuito da Cloudflare.

- PC ligado = avisos saem. PC desligado = os pedidos continuam normais, só os avisos de WhatsApp não saem.
- O WhatsApp fica salvo no banco: ao ligar o PC, reconecta sozinho, sem QR de novo.

## O que você precisa ter antes

1. **Um número só para o robô**: um chip separado, com WhatsApp ou WhatsApp Business instalado em um celular. Não use o número pessoal do dono.
2. **O PC da loja** (Windows 10 ou 11) com internet.
3. **Acesso à sua conta da Cloudflare** onde está o domínio `sistemaultrion.com.br`.
4. **A chave secreta do Supabase da Ponto X** (explico onde pegar na Etapa 3).

Tempo estimado: 40 a 60 minutos na primeira vez.

---

## Etapa 1 — Criar os 2 segredos (no seu computador)

Os segredos são senhas longas que só o site e o programa do WhatsApp conhecem. Vamos criar duas.

1. Aperte a tecla **Windows**, digite **PowerShell** e abra o "Windows PowerShell".
2. Copie esta linha, cole na janela e aperte **Enter**:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | % {[char]$_})
```

3. Vai aparecer uma sequência de 48 letras e números. **Esse é o primeiro segredo** (chamaremos de **TOKEN**). Copie e cole em um bloco de notas por enquanto.
4. Cole a mesma linha de novo e aperte **Enter**. A nova sequência é o **segundo segredo** (chamaremos de **SEGREDO-TENANT**). Cole no bloco de notas também.

Regras: os dois valores precisam ser **diferentes** e ter **mais de 32 caracteres** (esses têm 48). Não envie por WhatsApp, e-mail nem para mim. Guarde em um gerenciador de senhas e apague o bloco de notas no fim.

---

## Etapa 2 — Instalar o Node.js no PC da loja

O Node.js é o que "roda" o programa do WhatsApp.

1. No PC da loja, abra o navegador e entre em **nodejs.org**.
2. Clique no botão grande **LTS** (versão recomendada) e baixe.
3. Abra o arquivo baixado e clique em **Next** até **Install**. Deixe as opções como estão.
4. Para conferir: aperte **Windows**, digite **cmd**, abra o "Prompt de Comando", digite `node -v` e aperte Enter. Deve aparecer algo como `v22.x.x` (precisa ser 20 ou maior).

---

## Etapa 3 — Colocar o programa no PC da loja

1. Neste projeto (no seu computador) existe a pasta **`whatsapp-service`**. Copie essa pasta inteira para um pendrive (ou envie por um serviço que você use) e leve ao PC da loja.
2. No PC da loja, crie a pasta **`C:\pontox-whatsapp`** e cole **o conteúdo** da `whatsapp-service` lá dentro (devem ficar `index.js`, `package.json`, `iniciar-whatsapp.cmd` etc. direto em `C:\pontox-whatsapp`).
3. Dentro de `C:\pontox-whatsapp`, ache o arquivo **`.env.example`**. Faça uma cópia e renomeie a cópia para **`.env`** (se não aparecer a extensão, no Explorador vá em Exibir > Mostrar > Extensões de nomes de arquivos).
4. Abra o `.env` com o Bloco de Notas e preencha:

```
SUPABASE_URL=https://qknjjsdblasejgpbowjs.supabase.co
SUPABASE_SECRET_KEY=cole_aqui_a_chave_secreta_do_supabase
WA_SERVICE_TOKEN=cole_aqui_o_TOKEN_da_Etapa_1
WA_SERVICE_TENANT_SECRET=cole_aqui_o_SEGREDO-TENANT_da_Etapa_1
PORT=3000
HOST=127.0.0.1
```

   **Onde pegar a chave secreta do Supabase:** entre em supabase.com, abra o projeto da Ponto X, vá em **Project Settings > API Keys** e copie a chave **secret** (não a "publishable"). Essa chave dá poder total ao banco: só no `.env`, nunca em conversa.

5. Salve o `.env`.
6. Aperte **Windows**, digite **cmd**, abra o Prompt de Comando e digite (cada linha termina com Enter):

```
cd C:\pontox-whatsapp
npm ci
```

   Espere terminar (pode levar 1 a 3 minutos e mostrar avisos; é normal).

7. Teste: dê **dois cliques em `iniciar-whatsapp.cmd`**. Deve abrir uma janela preta com a frase **"Serviço do WhatsApp ouvindo em 127.0.0.1:3000"**. Se aparecer, está certo. Feche a janela por enquanto.
   - Se aparecer erro sobre `.env` ou variável faltando, volte ao passo 4 e confira os 4 valores.

---

## Etapa 4 — Criar o túnel da Cloudflare

O túnel é o "cano" seguro entre o site e o programa do PC, sem abrir nada no roteador.

1. No PC da loja, entre em **github.com/cloudflare/cloudflared/releases** e baixe o arquivo **`cloudflared-windows-amd64.msi`**. Instale clicando em Avançar.
2. Abra o Prompt de Comando **como administrador** (Windows, digite cmd, botão direito > Executar como administrador) e rode:

```
cloudflared tunnel login
```

   Vai abrir o navegador. Entre na Cloudflare e escolha o domínio **sistemaultrion.com.br**. Clique em **Authorize**.

3. Crie o túnel:

```
cloudflared tunnel create pontox-whatsapp
```

   No final aparece algo como `Created tunnel pontox-whatsapp with id xxxxxxxx-xxxx...`. **Anote esse ID** e o caminho do arquivo `.json` que ele mostra.

4. Crie o arquivo de configuração. Abra o Bloco de Notas e cole (troque `SEU-USUARIO` pelo nome da sua pasta de usuário do Windows e `ID-DO-TUNEL` pelo ID anotado):

```yaml
tunnel: pontox-whatsapp
credentials-file: C:\Users\SEU-USUARIO\.cloudflared\ID-DO-TUNEL.json

ingress:
  - hostname: wa-pontox.sistemaultrion.com.br
    service: http://127.0.0.1:3000
  - service: http_status:404
```

   Salve como **`config.yml`** em `C:\Users\SEU-USUARIO\.cloudflared\` (em "Tipo", escolha "Todos os arquivos" para não salvar como .txt).

5. Crie o endereço público do túnel:

```
cloudflared tunnel route dns pontox-whatsapp wa-pontox.sistemaultrion.com.br
```

6. Instale para iniciar sozinho com o Windows:

```
cloudflared service install
```

---

## Etapa 5 — Fazer o programa iniciar junto com o PC

1. Aperte **Windows**, digite **Agendador de Tarefas** e abra.
2. À direita, clique em **Criar Tarefa...** (não "Criar Tarefa Básica").
3. Aba **Geral**: nome **Ponto X WhatsApp**. Marque **"Executar estando o usuário conectado ou não"** e **"Executar com privilégios mais altos"**.
4. Aba **Disparadores** > **Novo...** > em "Iniciar a tarefa" escolha **Ao iniciar** > OK.
5. Aba **Ações** > **Novo...** > "Programa/script": clique em Procurar e escolha `C:\pontox-whatsapp\iniciar-whatsapp.cmd`. Em "Iniciar em" digite `C:\pontox-whatsapp` > OK.
6. Aba **Condições**: desmarque "Iniciar a tarefa somente se o computador estiver ligado na energia CA" (se existir).
7. OK. O Windows pede a senha do usuário: digite.
8. **Impedir que o PC durma:** Configurações > Sistema > Energia > em "Tela e suspensão" coloque **Nunca** para suspender.

Teste: reinicie o PC, espere 2 minutos e abra no navegador `https://wa-pontox.sistemaultrion.com.br/health`. Deve aparecer uma resposta (ok). Se aparecer erro, o programa ou o túnel não subiu: me mande o que aparece.

---

## Etapa 6 — Liberar o site para falar com o programa (no seu computador)

Aqui o site recebe os 2 segredos. Os valores nunca vão para o Git.

1. Abra o PowerShell **na pasta do projeto** (`C:\Users\joaov\Desktop\Ultrion\ponto-x-delivery`). Dica: no Explorador, abra a pasta, clique na barra de endereço, digite `powershell` e Enter.
2. Rode:

```
npx wrangler secret put WA_SERVICE_TOKEN
```

   Quando pedir o valor, cole o **TOKEN** (não aparece na tela, é normal) e aperte Enter.
3. Rode:

```
npx wrangler secret put WA_SERVICE_TENANT_SECRET
```

   Cole o **SEGREDO-TENANT** e Enter.
4. Me avise aqui. Eu faço o commit e a publicação (`WA_SERVICE_URL` já está no `wrangler.jsonc`).

---

## Etapa 7 — Conectar o número do robô e testar

1. Pegue o celular do **número do robô** com o WhatsApp aberto.
2. No painel da Ponto X, entre em **Loja > WhatsApp**, escolha o modo **QR** e clique em **Conectar**. Aparece um QR Code.
3. No celular: WhatsApp > **Configurações (ou ⋮) > Aparelhos conectados > Conectar um aparelho** e aponte a câmera para o QR.
4. Quando o painel mostrar **conectado**, use o botão de **teste** para mandar uma mensagem para o seu número.
5. Faça um pedido de teste e confira se o cliente recebe os avisos. (Depois apague o pedido de teste.)

---

## No dia a dia

- Ligue o PC antes de abrir. Em 1 a 2 minutos o programa e o túnel sobem sozinhos e o painel mostra "conectado".
- Se mostrar "desconectado": Loja > WhatsApp > reconectar (escanear o QR de novo).
- Não feche a janela preta do programa manualmente durante o expediente.
- Para atualizar o programa no futuro: substitua os arquivos em `C:\pontox-whatsapp` e reinicie o PC.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| `node` não é reconhecido | Reinstale o Node.js e abra um novo Prompt de Comando |
| Erro de variável no `.env` | Confira os 4 valores; token e segredo-tenant com 32+ caracteres e diferentes |
| `/health` não abre | Veja se a janela do programa está aberta e se o `cloudflared` está rodando (Serviços do Windows) |
| Painel diz "servidor do WhatsApp não configurado" | Os 2 segredos da Etapa 6 ainda não foram colocados ou falta publicar |
| QR não aparece | Confira se o túnel responde em `/health` |
| Mensagem não chega | Veja o histórico em Loja > WhatsApp (fila) e o status "conectado" |

## Riscos

- É uma automação não oficial do WhatsApp (Baileys): o número do robô pode ser restringido. Use número dedicado e evite mandar mensagem em massa.
- PC desligado ou sem internet = sem avisos. Se isso incomodar, dá para migrar para um servidor (VPS) depois.
