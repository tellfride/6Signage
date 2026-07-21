# 📺 6Signage — Digital Signage Corporativo

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
npm run seed admin@empresa.com SuaSenhaForte   # cria o usuário administrador
npm start                                       # http://SEU_IP:3000
```

Para rodar como serviço (systemd):

```bash
sudo tee /etc/systemd/system/6signage.service > /dev/null <<EOF
[Unit]
Description=6Signage Server
After=network.target
[Service]
WorkingDirectory=$(pwd)
ExecStart=$(which node) src/index.js
Environment=JWT_SECRET=troque-por-um-segredo-forte
Restart=always
User=$USER
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now 6signage
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
| Auth | `POST /api/auth/login` |
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

- JWT com expiração de 8 h; papéis admin/manager/viewer
- Telas novas exigem **aprovação manual** no painel
- Chave única por dispositivo (`device_key`) gerada localmente
- Validação de formato e tamanho nos uploads
- Para acesso fora da LAN: use HTTPS (nginx + certbot) e defina `JWT_SECRET`

## Roadmap

- [x] **Fase 1 (MVP)**: auth, mídia, playlists, grupos, players Windows/Android, tempo real,
  tema claro/escuro, usuários com permissão por grupo, painel de clima, rodapé de avisos, auto-update
- [ ] **Fase 2**: agendamentos (horário/dias da semana/prioridade), PostgreSQL, refresh tokens, screenshots ao vivo
- [ ] **Fase 3**: relatórios proof-of-play, transcodificação automática (FFmpeg), multi-tela, alertas de tela offline

## Licença

Uso interno/corporativo. Defina a licença conforme sua necessidade.
