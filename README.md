# Host My Game

Painel web para hospedar servidores de jogos no seu PC, no estilo do AMP.

## Instalar

Baixe o `HostMyGame-Setup-<versão>.exe` na página de Releases do GitHub e execute. O instalador já traz o Node.js e deixa o painel rodando como serviço do Windows, que inicia junto com o computador. Depois de instalar, abra http://localhost:8082.

- **Programa:** fica em `C:\Program Files\HostMyGame`.
- **Dados:** servidores, backups e contas ficam em `C:\ProgramData\HostMyGame`. Atualizar ou reinstalar não mexe nessa pasta. Ao desinstalar, o instalador pergunta se você quer apagá-la.
- **Atualizações:** o painel consulta o GitHub a cada 6 horas. Quando há versão nova, aparece um aviso para os administradores. Em Configurações → Atualizações do painel, o botão "Atualizar" para os servidores de jogo, instala a nova versão e reinicia o painel.

### Publicar uma versão nova

1. Mude `"version"` no `package.json` (ex.: `0.4.0`).
2. Faça o commit e crie a tag com o mesmo número: `git tag v0.4.0` e depois `git push origin main v0.4.0`.
3. O GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)) gera o instalador e publica o Release. Os painéis instalados passam a mostrar o aviso.

Para gerar o instalador no seu PC (precisa do Inno Setup 6), rode `powershell -ExecutionPolicy Bypass -File installer\build.ps1 -Repo usuario/repositorio`. O arquivo sai em `installer\build\`.

## Rodar pelo código-fonte

Requisito: Node.js 20.11 ou mais novo. O Java não é necessário, porque o painel baixa a versão certa sozinho.

```
npm install
npm start
```

Ou clique duas vezes em `Iniciar painel.bat`.

Depois, abra http://localhost:8082. No primeiro acesso você cria a conta de administrador.

## O que tem

**Catálogo com mais de 110 jogos.** Os App IDs e executáveis da Steam foram conferidos no SteamCMD.

- **Minecraft:** Vanilla, Paper, Purpur, Fabric, Forge, NeoForge, Velocity e Bedrock.
- **Sobrevivência:** Valheim, Palworld, Enshrouded, 7 Days to Die, Project Zomboid, Rust, ARK (Evolved e Ascended), Conan, V Rising, Sons of the Forest, Core Keeper, DayZ e outros.
- **Tiro:** Counter-Strike 2, Arma 3, Arma Reforger, Squad, Insurgency: Sandstorm e outros.
- **Source:** TF2, Garry's Mod, Left 4 Dead 1 e 2, CS:Source e outros.
- **Fora da Steam:** Terraria e Mindustry.
- **Qualquer outro jogo:** qualquer servidor da Steam pelo App ID (o executável é detectado sozinho) ou qualquer programa que você já tenha.

**Instâncias**
- **Criação:** tela com busca, categorias e imagem do jogo. Após criar, você escolhe entre não fazer nada, só instalar, instalar e iniciar, ou instalar e iniciar sempre.
- **Configurações do jogo** (nome, senha, portas, jogadores, mapa e outras). Antes de cada início, o painel aplica essas configurações nos argumentos e nos arquivos de configuração do próprio jogo.
- **Controle:** iniciar, parar (com salvamento quando o jogo permite), reiniciar, forçar parada, e ações em massa (iniciar, parar ou atualizar todas).
- **Console ao vivo**, que pode funcionar de quatro formas:
  - pela entrada padrão do servidor;
  - por pseudoconsole (para servidores que ignoram entrada redirecionada, como o Terraria);
  - por RCON;
  - por Telnet.
  Para servidores que só escrevem em arquivo, o painel acompanha o arquivo de log.
- **Status:** CPU e RAM somando todos os processos do servidor, jogadores online (consulta A2S da Steam, ping do Minecraft Java e Bedrock, ou leitura do log), tempo ligado e gráficos.
- **Atualizações:** o painel verifica novas versões a cada 30 minutos, mostra o aviso "Atualização disponível" e oferece o botão "Atualizar".
- **Reinício automático** quando o servidor trava, com proteção contra loop.
- **Arquivos:** navegar, editar, enviar (inclusive arrastando), baixar, renomear e excluir. Seleção múltipla para mover, copiar, compactar (.zip) ou excluir de uma vez; descompactar arquivos; baixar um arquivo direto de um link.
- **Jogadores:** quem está online, expulsar, banir e dar admin. No Minecraft também whitelist, operadores e banidos (com o servidor desligado, o painel edita os arquivos e busca o UUID na Mojang). No Project Zomboid usa os comandos de admin do jogo.
- **Opções do jogo** (aba Inicialização): editor visual do server.properties, servertest.ini e SandboxVars.lua, com a explicação de cada opção, listas de escolha, filtro e destaque do que mudou. Só as linhas alteradas são regravadas.
- **Detecção de problemas:** o painel lê o console e avisa sobre EULA não aceito, versão errada do Java, porta em uso, falta de memória ou de disco, token GSLT e mods incompatíveis. EULA e Java são corrigidos com um clique.
- **Trocar tipo/versão do Minecraft** (Configurações): muda entre Vanilla, Paper, Purpur, Fabric, Forge e NeoForge ou de versão. O servidor é reinstalado, com backup completo antes; mundo e configurações são mantidos.
- **Mods:**
  - **Minecraft** (Fabric, Forge, NeoForge, Paper, Purpur, Velocity): busca no Modrinth filtrada pela versão do servidor, instalação com um clique (as dependências vêm junto), ativar/desativar, remover e atualizar. Jars enviados à mão também são reconhecidos.
  - **Project Zomboid:** procure mods da Oficina Steam pelo nome (ou veja os mais inscritos e em alta), filtre por Build e clique em Instalar; vários cliques entram numa fila. Também dá para colar links de itens ou coleções inteiras. O painel baixa os itens, lê os Mod IDs e preenche `WorkshopItems=`, `Mods=` (com o formato do Build 42) e `Map=` sozinho. Dá para ativar/desativar cada mod, mudar a ordem de carregamento e ver avisos de dependências faltando ou de mods feitos para outro Build.
- **Backups** (`.tar.gz`) com descrição, restauração, limite de cópias, lista de exclusões (ex.: logs) e opção de travar um backup para nunca ser apagado. Reinstalar o servidor faz um backup antes. No Minecraft, o salvamento é pausado durante o backup.
- **Agendador** por servidor e global: cada tarefa tem vários passos em sequência (ex.: aviso → esperar 60s → backup → reiniciar), modelos prontos, opção "só se estiver ligado" e "executar agora".
- **Avançado:** sobrescrever executável, argumentos, modo do console, RCON, consulta, comandos de parada, branch beta da Steam e pasta de instalação.
- **Portas:** lista de portas, aviso de conflito e liberação no Firewall do Windows.

**Painel**
- **Usuários:** administradores e usuários com permissões por instância (console, controle, atualizar, arquivos, backups, agendador, configurações).
- **Verificação em duas etapas** (Google Authenticator, Microsoft Authenticator etc.) com códigos de recuperação.
- **Chaves de API** para bots e scripts (`Authorization: Bearer hmg_...`), com as mesmas permissões do dono da chave.
- **Usuários por servidor:** na aba Usuários de cada servidor o administrador dá acesso e escolhe as permissões de cada pessoa. Cada servidor mostra também a própria atividade recente.
- **Registro de atividades:** quem fez o quê e quando.
- **Conta Steam** para jogos que exigem login, com suporte ao código do Steam Guard.
- **Java automático** (Eclipse Temurin 8, 11, 17, 21 e 25) conforme a versão do jogo.

## Onde ficam os dados

Tudo fica em `data/`:

| Pasta / arquivo   | Conteúdo |
|-------------------|----------|
| `panel.json`      | Configurações, usuários e instâncias |
| `instances/`      | Servidores |
| `backups/`        | Backups |
| `tools/`          | SteamCMD e Java |
| `activity.log`    | Registro de atividades |

As variáveis de ambiente `HOST`, `PORT` e `HMG_DATA_DIR` têm prioridade sobre o `panel.json`.

## Observações

- **Painel:** a porta padrão é 8082, porque o AMP já usa a 8081. Por padrão o painel só aceita acesso deste computador; isso pode ser mudado em Configurações.
- **Jogar de fora da sua rede:** libere as portas do jogo no firewall (botão na aba Status) e no roteador.
- **Firewall automático:** só funciona com o painel rodando como administrador. Sem isso, o painel mostra os comandos para você rodar.
- **Valheim e Palworld:** o Valheim não tem comando de parada pelo console, então o painel encerra o processo e pode perder o progresso desde o último salvamento automático. O Palworld salva pelo RCON antes de parar.
