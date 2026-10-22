# Copiloto 9604

Painel de partida da equipe **FRC 9604**: autônomo estilo PathPlanner, odometria,
Limelight e um painel de teleoperado configurável (estilo Shuffleboard) — tudo num
programa só, em Python, que abre no navegador do notebook do Driver Station.

```
┌────────────┬──────────────────────────────────────────────────────────┐
│ Partida    │ Painel configurável: arraste, redimensione, várias abas │
│ Autônomo   │ Editor de rotas e autônomos no formato do PathPlanner    │
│ Odometria  │ Pose ao vivo, rastro, odometria × visão, calibração      │
│ Limelight  │ Vídeo, pipeline/LED, MegaTag no campo, distância, câmera │
│ Tópicos    │ Toda a NetworkTables em árvore, editar valores           │
│ Gravações  │ Grava cada partida e reproduz depois                     │
│ Config.    │ Equipe, robô, campo, pastas, Limelights, código do robô │
└────────────┴──────────────────────────────────────────────────────────┘
```

## Instalação (uma vez, com internet)

1. Instale o **Python 3.10 ou mais novo** (https://www.python.org). No Windows,
   marque **"Add python.exe to PATH"** no instalador.
2. Abra o Copiloto:
   - **Windows:** clique duas vezes em `iniciar_windows.bat`
   - **macOS/Linux:** `./iniciar_mac_linux.sh`

Na primeira vez o script cria a pasta `.venv` e instala o `pyntcore` (a
NetworkTables oficial do WPILib/RobotPy). Depois disso **funciona sem internet** —
importante, porque no evento o notebook não tem internet. A janela abre sozinha
(no Chrome/Edge em modo aplicativo) em `http://localhost:9604`.

Para fechar, feche a janela preta (terminal) ou aperte `Ctrl+C` nela.

### Opções

```
python copiloto.py --sim            # começa no simulador interno
python copiloto.py --rede           # tablets/celulares da rede podem abrir o painel
python copiloto.py --porta 9604     # outra porta
python copiloto.py --sem-navegador  # não abre a janela sozinho
```

> Com `--rede`, qualquer aparelho na mesma rede pode abrir o painel **e mandar
> valores para o robô**. Use só em redes da equipe.

## Conexão

Clique no indicador de conexão (canto superior direito) para escolher:

| Opção | Quando usar |
|---|---|
| Robô da equipe (10.96.4.2) | No campo e na oficina. Se o Driver Station estiver aberto, o IP vem dele. |
| Simulação WPILib (127.0.0.1) | Código do robô rodando no simulador do WPILib (`simulateJava`). |
| Endereço IP | Robô com outro IP. |
| Simulador interno | Sem robô: um robô de mentira publica tudo (útil para treinar e testar). |

No **simulador interno** o robô de mentira executa o autônomo escolhido no seletor
**com as rotas que vocês desenharam**, simula a Limelight vendo as AprilTags reais
de 2026, bateria, swerve, shooter etc. Pelo mesmo menu dá para pular direto para o
autônomo/teleoperado. Na aba Autônomo, o botão **Testar no simulador** roda o
autônomo aberto na hora.

`robo_simulado.py` faz o mesmo, mas como um **servidor NetworkTables de verdade**
em 127.0.0.1 (testa o caminho real da rede; também funciona com
Shuffleboard/AdvantageScope). Rode `python robo_simulado.py` e conecte em
"Simulação WPILib".

## As abas

### Partida (painel)
- **Editar layout** (ou tecla `E`): arraste pelo título, redimensione pelo canto,
  engrenagem para configurar. Os widgets empurram os outros para não sobrepor.
- 19 widgets: número, indicador (verdadeiro/falso), texto, título, gráfico, medidor,
  barra, botão, controle deslizante, seletor (SendableChooser), campo, câmera,
  tempo de partida, alertas, swerve, mira da Limelight, info da partida (FMS),
  linha do tempo e checklist.
- Várias abas (ex.: *Teleop* e *Pit*). Exporte/importe o layout em `.json`.
- Na aba **Tópicos**, o botão `+` de qualquer valor cria o widget certo para ele.
- A **linha do tempo** registra tudo que acontece: troca de modo, endgame,
  queda de bateria, alertas novos, perda de conexão e os tópicos que vocês
  escolherem vigiar.

### Autônomo (estilo PathPlanner)
Os arquivos são **os mesmos do PathPlanner** (`.path` e `.auto`, formato 2025),
salvos em `<projeto do robô>/src/main/deploy/pathplanner`. Então o
`AutoBuilder.buildAuto("nome")` do PathPlannerLib usa exatamente o que foi
desenhado aqui — e dá para continuar abrindo os mesmos arquivos no PathPlanner.

- Rotas com curvas Bézier: arraste pontos e alças, duplo clique adiciona ponto,
  ferramenta `+` perto da rota insere no meio (a curva não muda).
- Robô holonômico (swerve): **alvos de rotação**, rotação inicial e final.
- **Eventos** (comandos nomeados) com trecho opcional, **zonas de restrição**
  (ir mais devagar num trecho), restrições por rota ou padrão.
- **Prévia animada** com a rota colorida pela velocidade (azul = devagar,
  vermelho = rápido), tempo total, giro máximo exigido.
- **Autônomos**: sequência de rotas, comandos e esperas, grupos paralelo /
  sequência / corrida / prazo. Barra de tempo com o limite de 20 s do autônomo
  e o código Java dos `NamedCommands` pronto para copiar.
- Desfazer/refazer (`Ctrl+Z` / `Ctrl+Shift+Z`), salvamento automático,
  renomear rota atualiza os autônomos que a usam, excluir manda para
  `dados/lixeira`.
- **Mostrar como fica para a aliança vermelha** e **duplicar espelhado**.
- **Hot reload (experimental):** manda a rota para o PathPlannerLib no robô
  desabilitado sem fazer deploy. Para ficar permanente, sempre faça o deploy.

> O tempo da prévia é uma **estimativa** (perfil de velocidade com aceleração
> limitada, inclusive nas curvas). O PathPlannerLib usa o modelo físico completo
> do robô, então o tempo real pode variar um pouco.
>
> O PathPlannerLib precisa do `settings.json` com a configuração física do robô
> (`RobotConfig.fromGUISettings()`). Configure isso **uma vez** no app do
> PathPlanner (aba Settings → Robot Config); o Copiloto não mexe nesse arquivo.

### Odometria
- Pose do robô ao vivo (Field2d ou struct Pose2d), rastro, outros objetos do
  Field2d, rota ativa e alvo do PathPlannerLib.
- Pose da Limelight (MegaTag2 e MegaTag1) com linhas até as tags vistas, e o
  **erro odometria × visão** ao longo do tempo.
- **Definir pose**: clique onde o robô está e arraste na direção da frente.
- **Calibrar distância**: marca início/fim, compara com a trena e calcula o
  diâmetro efetivo da roda.
- **Calibrar rotação**: gire N voltas e veja o erro do giroscópio.

### Limelight
- Estado (online, pipeline, latência, alvo, tag, tx/ty/ta), vídeo com as tags
  marcadas por cima, botões de pipeline 0–9, LEDs, modo motorista, tag
  prioritária, modo do IMU (LL4).
- Pose MegaTag no campo, **calculadora de distância pelo ty** (e cálculo do
  ângulo da câmera a partir de uma distância medida), **posição da câmera no
  robô** (envia para a Limelight e gera o código) e o código do MegaTag2.
- Várias Limelights: cadastre em Configurações → Limelights.

### Gravações
Com o robô conectado, **cada vez que ele é habilitado o Copiloto grava todos os
tópicos** (para 8 s depois de desabilitar). Depois é só clicar em *Reproduzir*:
o painel, o campo, os gráficos e a Limelight mostram a partida como se o robô
estivesse ligado, com pausa, velocidade e linha do tempo.

## O que colocar no código do robô (Java)

Em Configurações tem tudo isso pronto para copiar. O mínimo:

```java
// RobotContainer
private final Field2d field = new Field2d();
SmartDashboard.putData("Field", field);

NamedCommands.registerCommand("Atirar", shooter.atirar());   // antes do chooser!
autoChooser = AutoBuilder.buildAutoChooser();
SmartDashboard.putData("Auto", autoChooser);

// Robot.robotPeriodic()
field.setRobotPose(drive.getPose());
SmartDashboard.putNumber("Match Time", DriverStation.getMatchTime());
SmartDashboard.putNumber("Bateria", RobotController.getBatteryVoltage());
```

Para o botão **Definir pose** funcionar, o drive precisa ouvir
`/Copiloto/ResetPose` (código em Odometria → Calibração). Os nomes dos tópicos
podem ser trocados em Configurações → Tópicos do robô.

## Dicas para o evento
- Abra o Copiloto **antes** de entrar na fila: ele fica procurando o robô e
  conecta sozinho.
- O vídeo da câmera usa banda do rádio. Pause quando não precisar.
- Antes do evento, troque a pasta do PathPlanner para a do projeto do robô
  (Configurações) e faça o deploy depois de mexer nas rotas.
- Faça backup (Configurações → Backup) e leve num pendrive.

## Estrutura (para quem quiser mexer)

```
copiloto.py              entrada (abre servidor e janela)
robo_simulado.py         robô de mentira com servidor NetworkTables real
servidor/
  app.py                 servidor HTTP + transmissão em tempo real (SSE)
  nt_ponte.py            ponte com a NetworkTables (pyntcore)
  structs.py             decodifica Pose2d, SwerveModuleState… (structs WPILib)
  simulador.py           robô simulado (segue as rotas, simula a Limelight)
  estado.py              valores atuais e gravação
  reproducao.py          reprodução de gravações
  arquivos.py            configuração, layouts, arquivos do PathPlanner
web/
  index.html, css/app.css
  js/app.js              barra superior e navegação
  js/nt.js               cliente da NetworkTables no navegador
  js/campo.js            desenho do campo (zoom, AprilTags, robô)
  js/trajetoria.js       Bézier, perfil de velocidade, formato PathPlanner
  js/widgets.js          os widgets do painel
  js/paginas/*.js        uma página por aba
dados/
  campos/*.json          AprilTags oficiais (2024, 2025, 2026)
  pathplanner/           rotas de exemplo (até configurar a pasta do robô)
  config.json, layouts.json, gravacoes/   (criados ao usar)
```

Só usa a biblioteca padrão do Python + `pyntcore`. A interface é HTML/CSS/JS
puro, sem nada da internet — funciona offline no evento.
