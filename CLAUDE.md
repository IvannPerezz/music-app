# BitChord Desktop — guía para Claude Code

Port para Windows de [BitChord](https://github.com/kushagrasinghx/BitChord) (cliente de YouTube Music para Android, GPL-3.0), hecho con **Electron 44** + JavaScript sin framework ni bundler. El usuario (Iván) habla español: la interfaz, los mensajes, los comentarios de cara al usuario y `CAMBIOS.txt` van en español.

## Comandos

```
npm install                # una vez
npm run mock               # app con datos de prueba, sin internet (perfil temporal)
npm run mock:account       # igual, simulando sesión de Google iniciada
npm start                  # app real (YouTube Music), usa el perfil real de %APPDATA%\BitChord
npm test                   # prueba de humo de la interfaz (Playwright) → tests/shots/*.png
npm run build:update       # empaqueta dist/update.bin
npm run deploy             # empaqueta y lo deja en la instalación de Iván como actualización
npm run package            # carpeta portable + instalador ligero en dist/ (descarga Electron)
```

## Cómo se entrega una versión (OBLIGATORIO en cada cambio, por pequeño que sea)

1. Sube la versión en **dos sitios**: `package.json` (`"version"`) y la etiqueta de `renderer/index.html` (`vX.Y.Z · port de BitChord`).
   Numeración: `MAYOR.MENOR.REVISIÓN` para novedades (0.6.5 → 0.6.6), y un cuarto número para retoques/arreglos pequeños (0.6.5 → 0.6.5.1).
2. Añade una entrada **arriba del todo** en `CAMBIOS.txt` (encima de la versión anterior, mismo formato con las líneas de guiones), en español y pensada para el usuario, no técnica.
3. `npm test` y revisa las capturas si tocaste la interfaz.
4. `npm run deploy`. Al cerrar y abrir BitChord, la versión se instala sola.

### Sistema de actualización (no romperlo)
- `loader.js` es el `main` del paquete. Al arrancar, si existe `resources\update.bin`, lo renombra a `resources\app-<tiempo>.asar`, escribe ese nombre en `resources\current.txt` y carga `main.js` desde ahí. Si la versión nueva falla al importar, vacía `current.txt` y arranca la de `app.asar`.
- **Nunca sobrescribas `resources\app.asar`** de una instalación: Windows lo mantiene bloqueado mientras BitChord (u otra app Electron que haya mirado dentro del .asar) esté abierta. Por eso existe `update.bin`.
- No hagas `ls`/`dir` dentro de un `.asar` desde una herramienta basada en Electron: lo deja abierto y bloqueado.
- El instalador (`installer/instalar.ps1`) borra `current.txt` y `update.bin`: reinstalar con el .zip vuelve a la versión del .zip.

## Estructura

**Proceso principal** (Node, ESM):
- `loader.js` — arranque y actualizaciones (ver arriba).
- `main.js` — ventana, bandeja, miniaturas de la barra de tareas, registro (`%APPDATA%\BitChord\bitchord.log`) y **todos los manejadores IPC** (`handle('canal', fn)`). Para un canal nuevo: añádelo aquí, en la lista `channels` de `preload.cjs` (se expone en `window.bc` en camelCase) y llámalo desde el renderer con `api('canal', …)`. Los eventos main→renderer (`send`) deben estar en la lista de `on` de `preload.cjs`.
- `src/yt.js` — todo YouTube Music con **youtubei.js 18**: inicio, búsqueda, álbumes, artistas, playlists, biblioteca, crear playlists, y **resolución del audio** (`resolveStream`). Contiene:
  - `Platform.shim.eval` con `node:vm` (youtubei.js ya no trae evaluador de JS; sin esto no se descifran URLs).
  - Lista `CLIENTS` en orden de preferencia: `ANDROID (2AMB)` e `IOS (2AMB)` primero (piden `/player` con `params: '2AMB'`, que desde agosto de 2026 sigue dando audio completo sin token); luego clientes web con **PO token**.
  - Los clientes móviles (`ANDROID*`, `IOS`) van **sin cookies** con una sesión anónima aparte (con cookies YouTube responde 400). Los PO tokens (el del `/player` y el GVS que va en la URL como `pot=`) se generan **ligados al ID del vídeo**, con o sin sesión: ligados al visitorData o al Data Sync ID, como antes, YouTube los ignora desde 2026 y corta a ~1 MiB. Con la sesión de Iván, `YTMUSIC + PoToken` sirve también canciones con restricción de edad (los móviles sin cookies no).
  - `probe()` comprueba cada URL leyendo a ~2,5 MiB (YouTube corta a ~1 MiB/76 s los audios sin autorización).
  - **Cortacircuitos**: si YouTube devuelve 429/403 "Sorry…" o rechaza todos los clientes en 3 canciones seguidas, se pausan las peticiones (2→60 min) y se avisa a la interfaz (`yt-status`). No elimines esto: un bucle de reintentos le costó a Iván horas de bloqueo.
- `src/potoken.js` + `assets/po_token.html` — BotGuard en una ventana oculta para generar PO tokens.
- `src/proxy.js` — servidor local `127.0.0.1:47831` (`/stream`, `/local`, `/cover`, `/plcover`, `/webdav`…) que sirve el audio al reproductor por rangos y cambia de cliente a mitad de canción si uno deja de servir.
- `src/auth.js` + `src/login-preload.cjs` — inicio de sesión de Google en una ventana con identidad de Firefox; cookie cifrada con `safeStorage` en `auth.bin`.
- `src/downloads.js` + `src/mux/*` — descargas con etiquetas y carátula (Opus/WebM y M4A).
- `src/local.js` — música local: índice, carpetas como playlists, portadas y vigilancia de cambios (`fs.watch`).
- `src/playlists.js` — portadas personalizadas de las playlists de YouTube Music (guardadas solo en este PC). Desde la v0.6.37 **no hay playlists propias de BitChord**: todas viven en la cuenta de YouTube Music (crear, añadir canciones, importar y sincronizar con Spotify). No las vuelvas a añadir.
- Spotify (Importar): `src/spotify-web.js` (inicio de sesión en la página de Spotify con la partición `persist:spotify`, como la app oficial; el token se toma de las peticiones del reproductor web en una ventana oculta), `src/spotify-sync.js` (lee playlists con la API GraphQL interna de open.spotify.com y las copia/sincroniza en la cuenta de YouTube Music) y `src/spotify-match.js` (busca cada canción en YouTube Music). Ya no hay importación por .zip ni app de desarrollador.
- `src/lyrics.js` — proveedores de letras. `src/sources/*` — JioSaavn y WebDAV. `src/discord.js`, `src/scrobble.js` — integraciones.
- `src/settings.js` — `DEFAULTS` de todos los ajustes (`settings.json` en el perfil).
- `src/mock.js` — datos de prueba para `npm run mock`/tests (no se empaqueta).

**Interfaz** (`renderer/`, módulos ES, sin framework):
- `index.html` + `styles.css` (temas por `:root[data-theme=…]`, efecto Mica `--mica-tint`, fondo animado `#ambient`).
- `app.js` — router (`go`, `render`, `views`), barra lateral, tarjetas/filas, reproductor, cola, letras, vista de portada y letra, menús, avisos, acento dinámico y fondo animado.
- `core.js` — `api()`, `state`, `store` (localStorage), `toast`, utilidades. `engine.js` — motor de audio Web Audio (dos pletinas, crossfade, Automix, EQ). `analysis-worker.js` — BPM/compases para Automix.
- `settings-view.js`, `library-view.js`, `import-view.js`, `eq-panel.js`, `color-picker.js`, `lyrics-parse.js`, `icons.js`.
- `lyrics-view.js` — letra sincronizada estilo Apple Music: cada línea se mueve con un muelle por script (cascada, desenfoque por distancia vía `--d`), y las palabras de las líneas que suenan se rellenan, suben y brillan fotograma a fotograma; reloj interpolado en `app.js` (`lyricsTime`, resta la latencia de salida). `lyrics-look.js` — los controles de su aspecto (menú de la letra y Ajustes), en vivo.
- `visualizer.js` + `visualizer/` — visualizador MilkDrop (Butterchurn, MIT, copiado en `visualizer/vendor/`). Va en un **iframe sandbox** servido por el proxy en `/vis/` (`src/vis-files.js`, también en el mock): Butterchurn necesita `eval` para los presets y la ventana principal no lo permite (CSP). La app le manda las muestras de audio (tomadas tras el ecualizador, `engine.tap`) por `postMessage` en cada fotograma.

## Idiomas (OBLIGATORIO para cualquier texto nuevo de la interfaz)
- Todo texto que vea el usuario pasa por `tr('texto en español')` (`renderer/i18n.js` en la interfaz, `src/i18n.js` en el proceso principal). Se llama `tr` porque `t` es una canción en todo el código. Variables con llaves: `tr('{n} canciones', { n })`.
- La traducción inglesa va en `renderer/i18n/en.js` (clave = el texto español exacto). `npm test` ejecuta antes `node scripts/i18n-keys.mjs`, que falla si falta alguna traducción.
- Textos fijos de `index.html`: `title`/`placeholder` se traducen solos al arrancar; para texto visible añade `data-i18n`.
- El idioma de la interfaz (`uiLanguage`, Ajustes → General) es distinto del de YouTube Music (`language`). Se lee al cargar los módulos (copia en `localStorage`), así que cambiarlo recarga la ventana.

## Cosas a tener en cuenta
- Desde la nube no se podía probar contra YouTube; **en este PC sí**: después de tocar `src/yt.js` o `src/proxy.js`, prueba con `npm start` y mira `bitchord.log` (cada canción apunta qué cliente consiguió el audio: `[yt] audio de … vía …`).
- `backdrop-filter` (efecto Mica) deja de funcionar si un antecesor tiene una animación con `fill-mode: both/forwards` activa; por eso `.view-in` usa `backwards`.
- No añadas fuentes de música sin licencia (Qobuz/Deezer/Tidal "ripeados", etc.). Iván ya preguntó; la respuesta fue no.
- Licencia GPL-3.0 (heredada de BitChord).
