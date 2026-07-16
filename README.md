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

**Painel web (responsivo, mobile-first)**
- Dashboard "video wall": cada TV é um card com status ao vivo (online/offline), o que
  está no ar agora, resolução e grupo — atualizado a cada 15 s
- Aprovação manual de novas telas (segurança: nenhum player entra sozinho)
- Editor de playlists: ordem, duração por item, transições (fade/corte), duração total do ciclo
- Biblioteca de mídia com upload por arrastar-e-soltar (MP4, MKV, WebM, JPG, PNG, WebP, até 1 GB)
- Grupos de telas: envie uma playlist para várias TVs de uma vez
- Controle remoto: avançar, pausar, retomar, reiniciar player
- Download dos agentes (Windows/Android) direto do painel
- Login JWT com papéis (admin/manager/viewer)

**Players (Windows e Android TV)**
- Assistente de configuração na primeira execução: endereço do servidor + nome da tela,
  com teste de conexão — sem editar arquivos
- Registro automático no servidor com chave única por dispositivo
- Cache local de toda a mídia com validação SHA-256 — **funciona sem rede**
  (continua exibindo a última playlist se a conexão cair)
- Atualização instantânea via WebSocket + polling de segurança a cada 60 s
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
`server/downloads/` (ou anexe nas Releases):

```bash
# Agente Windows (em uma máquina Windows, ou Linux com Wine para o Setup.exe)
cd player && npm install && npm run dist

# Agente Android (requer JDK 17 + Android SDK 34)
cd android && gradle assembleRelease
# APK em android/app/build/outputs/apk/release/app-release.apk
```

Renomeie para `6SignagePlayer-win64.zip` / `6SignagePlayer.apk` dentro de
`server/downloads/` para os botões de download do painel funcionarem.

## API (resumo)

| Área | Endpoints |
|---|---|
| Auth | `POST /api/auth/login` |
| Telas | `GET/PUT/DELETE /api/devices`, `POST /api/devices/:id/command` |
| Playlists | CRUD + `PUT /api/playlists/:id/items` + `POST /api/playlists/:id/assign` |
| Mídia | `GET /api/media`, `POST /api/media/upload`, `DELETE /api/media/:id` |
| Grupos | CRUD `/api/groups` |
| Player | `POST /api/devices/register`, `GET /api/player/manifest`, `POST /api/player/heartbeat` |
| Infra | `GET /api/health`, WebSocket em `/ws?device_key=...` |

## Segurança

- JWT com expiração de 8 h; papéis admin/manager/viewer
- Telas novas exigem **aprovação manual** no painel
- Chave única por dispositivo (`device_key`) gerada localmente
- Validação de formato e tamanho nos uploads
- Para acesso fora da LAN: use HTTPS (nginx + certbot) e defina `JWT_SECRET`

## Roadmap

- [x] **Fase 1 (MVP)**: auth, mídia, playlists, grupos, players Windows/Android, tempo real
- [ ] **Fase 2**: agendamentos (horário/dias da semana/prioridade), PostgreSQL, refresh tokens, screenshots ao vivo
- [ ] **Fase 3**: relatórios proof-of-play, transcodificação automática (FFmpeg), multi-tela, alertas de tela offline

## Licença

Uso interno/corporativo. Defina a licença conforme sua necessidade.
