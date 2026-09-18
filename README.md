# 📺 VitriniON — Digital Signage Corporativo

Sistema completo de **sinalização digital** cliente-servidor: um servidor Linux gerencia
playlists de vídeos e imagens e distribui automaticamente para telas Windows e Android TV,
com painel de controle web responsivo (desktop e celular).

```
┌─────────────────┐     HTTP/WebSocket      ┌──────────────────┐
│  Servidor Linux │ ◄─────────────────────► │  Player Windows  │──► TV
│  Node + SQLite  │                         └──────────────────┘
│  Painel Web     │ ◄─────────────────────► ┌──────────────────┐
│  API REST + WS  │                         │  Player Android  │──► TV
└─────────────────┘                         └──────────────────┘
        ▲
        │ navegador (desktop/celular)
   Painel de controle
```

## Funcionalidades

**Painel web (responsivo, mobile-first, tema claro/escuro)**
- Dashboard "video wall": cada TV é um card com status ao vivo (online/offline), o que
  está no ar agora, resolução, orientação e grupo — atualizado a cada 15 s. Alterne para
  **visualização em lista** (ícone ao lado da busca, preferência salva) para conferir
  muitas telas de uma vez — cada linha traz um **ícone de tela em pé (retrato) ou deitada
  (paisagem)** para identificar a orientação num piscar de olhos
- **Inventário de cada tela**: plataforma (Windows ou Android) **detectada automaticamente
  pelo próprio agente** no registro — sem digitação manual; tamanho físico em polegadas
  (editável, já que nenhum software expõe o tamanho de um monitor) e local, para um
  parque com tamanhos e orientações variados (18" a 70", paisagem ou retrato)
- Aprovação manual de novas telas (segurança: nenhum player entra sozinho)
- Editor de playlists: ordem, duração por item, transições (fade/corte), duração total do ciclo
- **Editor de layout com pré-visualização ao vivo** (por tela): liga/desliga o painel de
  clima e o rodapé de avisos, com o resultado mostrado em tempo real
- Biblioteca de mídia com upload por arrastar-e-soltar (MP4, MKV, WebM, JPG, PNG, WebP, até 1 GB)
- Grupos de telas: envie uma playlist para várias TVs de uma vez
- **Usuários e permissões**: papéis admin/editor/visualizador; editores publicam apenas
  nos grupos autorizados
- Controle remoto: avançar, pausar, retomar, reiniciar player
- Download dos agentes (Windows/Android) direto do painel
- Login JWT

**Playlists em quatro tipos** (aba Playlists)
- **Mídia**: sequência de vídeos e imagens
- **Rodapé**: faixas de avisos reutilizáveis — aplique em uma tela, em várias ou em
  todas; uma tela pode exibir **várias faixas** ao mesmo tempo (as mensagens se juntam
  num fluxo único)
- **Barra lateral**: perfis de clima reutilizáveis — um perfil serve várias telas
- **Layout**: perfis de tamanho + fundo (largura da coluna, altura do rodapé, cor ou
  imagem de fundo), **atrelável a um grupo inteiro ou a uma tela específica** — o
  override de uma tela sempre vence o padrão herdado do grupo

**Overlays na tela (opcionais, por tela ou por grupo)**
- **Barra lateral de clima**: relógio, data, temperatura atual e **previsão de amanhã**
  (máx/mín). Localidade por **cidade ou CEP** (via [BrasilAPI](https://brasilapi.com.br),
  mais preciso); dados meteorológicos da [Open-Meteo](https://open-meteo.com) — ambas
  gratuitas e sem chave
- **Rodapé de avisos**: mensagens rolando em fluxo contínuo, da borda direita até a esquerda
- **Tamanhos ajustáveis**: largura da coluna lateral (10–45%) e altura do rodapé (6–30%),
  com pré-visualização ao vivo — a tipografia escala junto
- **Fundo personalizável**: automático (gradiente padrão), cor sólida ou imagem (JPG/PNG/WEBP)
  para a barra lateral e para o rodapé, cada um independente
- **Orientação paisagem/retrato**: detectada automaticamente pela resolução que a
  própria tela reporta (ex.: 1080x1920 → retrato), com opção de forçar manualmente no
  perfil de layout. O console mostra o espelho de cada tela na proporção real —
  telas em retrato aparecem estreitas e altas no video wall, facilitando a visualização
  num parque com tamanhos variados (18" a 70", paisagem ou retrato)

**Players (Windows e Android TV)**
- Assistente de configuração na primeira execução: endereço do servidor + nome da tela,
  com teste de conexão — sem editar arquivos
- Registro automático no servidor com chave única por dispositivo
- Cache local de toda a mídia com validação SHA-256 — **funciona sem rede**
  (continua exibindo a última playlist se a conexão cair)
- Atualização instantânea via WebSocket + polling de segurança a cada 60 s
- **Auto-update**: o player verifica a versão no servidor (ao iniciar e a cada 6 h) e
  se atualiza sozinho, sem visitar a TV. No Windows a troca é silenciosa (baixa só o
  código, ~25 KB); no Android o instalador do sistema pede uma confirmação no controle
- Heartbeat a cada 30 s (status e mídia atual visíveis no painel)
- Fullscreen/kiosk, tela sempre ligada, transições suaves

## Estrutura do repositório

| Pasta | Conteúdo |
|---|---|
| `server/` | Servidor central: API REST + WebSocket + painel web (Node.js, Express, SQLite) |
| `player/` | Player Windows (Electron) |
| `android/` | Player Android TV (Java + WebView, APK ~19 KB) |

---

## Instalação

### 1. Servidor (Linux)

Requisito: **Node.js 22+** (usa o SQLite embutido do Node — sem banco externo).

```bash
git clone https://github.com/tellfride/6Signage.git
cd 6Signage/server
npm install
npm run seed -- --super seu@email.com SuaSenhaForte   # cria o super_admin (dono do sistema)
npm start                                              # http://SEU_IP:3000
```

O `super_admin` é quem cadastra as empresas-cliente (aba **Empresas** no painel — cada
empresa já nasce com seu próprio admin). Sem a flag `--super`, `npm run seed
email senha` cria um `admin` comum preso à "Empresa Padrão" (útil só se você
não for usar multi-empresa). Rodar `npm run seed -- --super ...` de novo com o
mesmo e-mail troca a senha e garante o papel `super_admin` nessa conta.

Para rodar como serviço (systemd):

```bash
sudo tee /etc/systemd/system/vitrinion.service > /dev/null <<EOF
[Unit]
Description=VitriniON Server
After=network.target
[Service]
WorkingDirectory=$(pwd)
ExecStart=$(which node) src/index.js
Environment=NODE_ENV=production
Environment=JWT_SECRET=troque-por-um-segredo-forte
Environment=TURNSTILE_SITE_KEY=sua-site-key
Environment=TURNSTILE_SECRET_KEY=sua-secret-key
Environment=EVOLUTION_API_URL=https://sua-instancia-evolution-api.com
Environment=EVOLUTION_API_KEY=sua-api-key
Environment=EVOLUTION_INSTANCE=nome-da-instancia
Restart=always
User=$USER
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now vitrinion
```

Acesse `http://SEU_IP:3000` no navegador (funciona no celular) e faça login.

### 2. Player Windows (nas TVs)

**Pelo agente pronto** (depois de gerar — ver "Gerando os agentes" abaixo — ele fica
disponível no painel, aba Telas → *"⬇ Agente Windows"*):

1. Baixe `6SignagePlayer-win64.zip` na máquina da TV e extraia.
2. Execute `Instalar-6Signage-Player.bat` — instala, cria atalho na inicialização
   do Windows e abre o player.
3. No assistente: endereço do servidor + nome da tela → **Testar conexão** → **Salvar**.

Atalhos: `Ctrl+Shift+S` reconfigura · `Ctrl+Shift+Q` sai.

**Pelo código-fonte:** `cd player && npm install && npm start`.

### 3. Player Android (Android TV / TV Box)

1. Baixe `6SignagePlayer.apk` na TV (painel → *"⬇ Agente Android"*).
2. Habilite "Fontes desconhecidas" e instale
   (ou `adb connect IP_DA_TV && adb install 6SignagePlayer.apk`).
3. Abra o app e siga o assistente (servidor + nome da tela).
4. **Botão VOLTAR** do controle alterna entre player e configuração.

Mínimo: Android 5.0. Compatível com launcher Leanback (Android TV).

### 4. Primeiro uso (fluxo completo)

1. **Mídia** → envie vídeos e imagens.
2. **Playlists** → crie uma playlist e adicione as mídias na ordem.
3. Instale o player na TV → ela aparece em **Telas** → clique **Aprovar**.
4. Selecione a playlist da TV (ou atribua a um **Grupo**) — a tela atualiza sozinha
   em segundos, baixa o conteúdo e começa a exibir.

---

## Gerando os agentes (artefatos de build)

Os instaladores não são versionados no repositório — gere-os e coloque em
`server/downloads/`:

```bash
# Agente Windows — gera win-unpacked e empacota o ZIP
cd player && npm install
npx electron-builder --win --x64 --dir
# publique os DOIS arquivos:
cp dist/win-unpacked/resources/app.asar ../server/downloads/player-app.asar   # p/ auto-update
# (empacote dist/win-unpacked + o .bat em 6SignagePlayer-win64.zip)

# Agente Android (requer JDK 17 + Android SDK 34)
cd android && gradle assembleRelease
cp app/build/outputs/apk/release/app-release.apk ../server/downloads/6SignagePlayer.apk
```

Os arquivos em `server/downloads/`: `6SignagePlayer-win64.zip` (instalação nova no
Windows), `player-app.asar` (auto-update do Windows) e `6SignagePlayer.apk` (Android,
instalação nova e auto-update).

### Publicando uma atualização (auto-update)

1. Aumente a versão: `player/package.json` (`version`) para o Windows;
   `android/app/build.gradle` (`versionCode` **e** `versionName`) para o Android.
2. Recompile os agentes (comandos acima) e copie os artefatos para `server/downloads/`.
3. Edite `server/player-version.json` com os novos números de versão.
4. Pronto: em até 6 h (ou ao reiniciar) cada TV se atualiza sozinha. Para forçar agora,
   use o botão **⬆** no card da tela, no painel.

> **Android:** mantenha sempre a mesma chave de assinatura (o build usa a *debug key*
> de `~/.android/debug.keystore`). O Android recusa atualizações assinadas com chave
> diferente. Para produção, gere uma chave de release própria e use-a de forma fixa.

## API (resumo)

| Área | Endpoints |
|---|---|
| Auth | `POST /api/auth/login` (captcha + bloqueio por tentativas) |
| Config pública | `GET /api/config` (site key do captcha) |
| Empresas | CRUD `/api/companies` + `POST /api/companies/:id/renew` (somente super_admin) · `GET /api/company` (própria empresa, qualquer papel) |
| Usuários | CRUD `/api/users` + `POST /api/users/:id/unlock` |
| Telas | `GET/PUT/DELETE /api/devices`, `POST /api/devices/:id/command` |
| Playlists | CRUD + `PUT /api/playlists/:id/items` + `POST /api/playlists/:id/assign` |
| Rodapé | CRUD `/api/tickers` + `PUT /api/tickers/:id/devices` |
| Barra lateral | CRUD `/api/sidebars` + `PUT /api/sidebars/:id/devices` |
| Layout (por tela) | `PUT /api/devices/:id/layout` (perfil, faixas, larguras) |
| Layout (perfis) | CRUD `/api/layouts` + `PUT /api/layouts/:id/devices` + `PUT /api/layouts/:id/groups` + `POST /api/layouts/:id/background` |
| Clima | `GET /api/weather/search?q=`, `GET /api/weather/cep?cep=` |
| Mídia | `GET /api/media`, `POST /api/media/upload`, `DELETE /api/media/:id` |
| Grupos | CRUD `/api/groups` |
| Player | `POST /api/devices/register`, `GET /api/player/manifest`, `POST /api/player/heartbeat` |
| Update | `GET /api/player/version?platform=win\|android` |
| Infra | `GET /api/health`, WebSocket em `/ws?device_key=...` |

## Segurança

- JWT com expiração de 8 h; papéis super_admin/admin/manager/viewer
- **Multi-tenancy**: cada empresa só vê seus próprios usuários, telas, playlists, mídia,
  grupos, rodapés, perfis de clima e de layout. `super_admin` enxerga todas as empresas
  e escolhe a "empresa ativa" no painel para agir em nome dela.
- **Captcha** (Cloudflare Turnstile) no login — defina `TURNSTILE_SITE_KEY` e
  `TURNSTILE_SECRET_KEY`; sem elas, o captcha fica desativado (modo dev).
- **Bloqueio de conta**: 3 senhas erradas seguidas bloqueiam a conta por 3 min; um
  admin pode desbloquear antes disso na aba Usuários.
- `JWT_SECRET` é **obrigatório** em produção (`NODE_ENV=production`) — o servidor
  recusa iniciar sem ele, em vez de cair num segredo previsível.
- Rate limiting: login (por IP), registro de tela (por IP), manifest/heartbeat (por
  `device_key`) — ver `express-rate-limit` em `server/src/index.js`.
- Headers de segurança via `helmet` (CSP ainda desativada — calibrar com o domínio
  do Turnstile antes de habilitar em produção).
- Telas novas exigem **aprovação manual** no painel; ao aprovar, a tela passa a
  pertencer à empresa de quem aprovou (antes disso, fica num pool visível a
  qualquer admin, sem expor mídia/playlist — só nome, resolução e plataforma).
- Chave única por dispositivo (`device_key`) gerada localmente
- Validação de formato e tamanho nos uploads
- Para acesso fora da LAN: use HTTPS (nginx + certbot)

**Fora do escopo atual (fast-follow, exige mudança nos players):** `/media` e
`/backgrounds` ainda são servidos sem checar a empresa do arquivo — os players
baixam mídia só com `device_key`, sem JWT, então travar isso exige que os players
passem a mandar `device_key` nessas URLs também. O token do painel também continua
em `localStorage` (não em cookie httpOnly) — migrar isso é independente do resto e
pode ser feito depois.

## Assinatura por empresa (comercial)

Cada empresa tem, opcionalmente, uma data de vencimento (`due_date`) e um limite de
telas (`screen_limit`), configuráveis pelo `super_admin` na aba **Empresas** do painel:

- **Sem gateway de pagamento**: a cobrança é feita por fora (PIX/boleto); o
  `super_admin` marca a renovação no painel (botão "Renovar +30 dias"/"+1 ano", ou
  editando a data manualmente), o que também reativa a empresa automaticamente se
  estava suspensa.
- **Limite de telas**: ao tentar aprovar uma tela além do `screen_limit` da empresa,
  a aprovação é recusada com uma mensagem clara. Limite vazio = sem limite.
- **Vencimento**: quando `due_date` passa da data atual (ou a empresa é suspensa
  manualmente), login e qualquer ação autenticada do painel passam a retornar erro
  para todo mundo da empresa, exceto `super_admin` — inclusive para sessões já
  abertas (o token de até 8h para de funcionar assim que a empresa vence, não só em
  logins novos). **As telas continuam exibindo o último conteúdo normalmente**: os
  endpoints do player (`register`/`manifest`/`heartbeat`/WebSocket) autenticam por
  `device_key`, não por login, e não são afetados.
- **Aviso por WhatsApp**: um job diário (09h, via `node-cron`) verifica empresas
  perto do vencimento e manda uma mensagem de WhatsApp para o número cadastrado em
  cada empresa — um aviso ~3 dias antes, um no dia do vencimento, e um quando já
  venceu (cada estágio é enviado só uma vez, controlado por `last_reminder_stage`).
  Fica registrado em `notifications_log` (útil pra comprovar que o aviso saiu).

  Isso depende de uma instância da **[Evolution API](https://github.com/EvolutionAPI/evolution-api)**
  (self-hosted, grátis) configurada à parte — defina `EVOLUTION_API_URL`,
  `EVOLUTION_API_KEY` e `EVOLUTION_INSTANCE`. Sem essas variáveis, o sistema
  continua funcionando normalmente — o envio só é pulado e fica registrado como
  `not_configured` no log. Trocar de provedor (Z-API, Meta Cloud API etc.) é reescrever
  `server/src/whatsapp.js`, sem tocar no resto do sistema. Para testar sem esperar o
  horário do cron, defina `CHECK_DUE_ON_BOOT=1` — a checagem roda uma vez assim que
  o servidor sobe.

## Roadmap

- [x] **Fase 1 (MVP)**: auth, mídia, playlists, grupos, players Windows/Android, tempo real,
  tema claro/escuro, usuários com permissão por grupo, painel de clima, rodapé de avisos, auto-update
- [x] **Fase 1.5**: rebranding VitriniON, captcha no login, bloqueio de conta por tentativas,
  multi-tenancy (empresas isoladas + super_admin), hardening (rate limit, helmet, JWT_SECRET obrigatório)
- [x] **Fase 1.6**: assinatura por empresa (vencimento, limite de telas, bloqueio automático),
  aviso de vencimento por WhatsApp (Evolution API)
- [ ] **Fase 2**: agendamentos (horário/dias da semana/prioridade), PostgreSQL, refresh tokens,
  screenshots ao vivo, `/media`/`/backgrounds` tenant-aware, cookie httpOnly para o token do painel
- [ ] **Fase 3**: relatórios proof-of-play, transcodificação automática (FFmpeg), multi-tela, alertas de tela offline

## Licença

Uso interno/corporativo. Defina a licença conforme sua necessidade.
