# NPI - Secret Santa: publicarlo y administrarlo

Los datos viven en una base de datos de Cloudflare y el código en GitHub. Tus amigos solo necesitan un enlace y su contraseña. Cuesta cero y no pide tarjeta.

```
secret-santa-app/
├── wrangler.toml        configuración (aquí pegas el ID de tu base de datos)
├── GUIA.md              esta guía
├── src/worker.js        la API (contraseñas, listas, fotos, años)
├── src/seed.js          datos iniciales: nombres, contraseñas cifradas y dulces ya capturados
└── public/index.html    la app que ven tus amigos y tu pantalla de administración
```

## Qué incluye
- Listas de hasta 10 dulces con foto opcional, pantalla individual compacta y fotos que se abren en grande.
- Un viernes de regalo por semana, desbloqueado automáticamente a las 00:00 (hora del centro de México). El primer viernes y el número de viernes los defines tú.
- **Administración** (solo tú): cambiar año y fechas, renombrar, agregar o quitar participantes, cambiar contraseñas.
- **Cambio de año**: guarda una copia completa de la edición (nombres, dulces, marcas y fotos) y empieza una nueva.
- **Ediciones anteriores**: consulta en modo solo lectura cualquier año guardado.
- Mensajes para el grupo (estatus, pendientes, viernes) para enviar tú por WhatsApp o correo.
- Ya vienen cargados 13 de los 14 participantes (falta Yenni).

---

## A. Primera vez (30 a 40 minutos)

### 1. Sube el código a GitHub
1. Descomprime `secret-santa-app.zip`.
2. En github.com crea un repositorio **privado** (por ejemplo `secret-santa`). Debe ser privado porque `src/seed.js` contiene las contraseñas cifradas de tus amigos.
3. *Add file > Upload files*. Arrastra **el contenido** de la carpeta (`wrangler.toml`, `GUIA.md`, y las carpetas `src` y `public`) para que `wrangler.toml` quede en la raíz. Pulsa *Commit changes*.

### 2. Crea la base de datos en Cloudflare
1. En dash.cloudflare.com abre *Storage & databases > D1 SQL database > Create database* y llámala exactamente `secret-santa`.
2. Copia su **Database ID**. No hay que pegar ningún SQL: las tablas y los datos iniciales se crean solos al abrir la app por primera vez.

### 3. Pega el ID
En GitHub abre `wrangler.toml`, pulsa el lápiz, cambia `PEGA-AQUI-EL-ID-DE-TU-BASE-DE-DATOS` por tu Database ID entre comillas y pulsa *Commit changes*.

### 4. Conecta GitHub con Cloudflare
1. Abre https://dash.cloudflare.com/?to=/:account/workers-and-pages
2. *Create application > Import a repository*. Autoriza GitHub y elige el repositorio.
3. Nombre del proyecto: `secret-santa` (igual que en `wrangler.toml`). Rama `main`. *Build command*: vacío. *Deploy command*: `npx wrangler deploy`. Pulsa *Save and Deploy*.
4. Al terminar te da una dirección parecida a `https://secret-santa.TU-USUARIO.workers.dev`.

### 5. Carga las dos claves secretas
En el Worker `secret-santa`: *Settings > Variables and secrets > Add variable*. Marca **Secret** en cada una y pulsa *Add variable and deploy*:
- `ADMIN_TOKEN`: una clave larga (40 caracteres o más). Es tu clave de organizador: guárdala bien.
- `HASH_SALT`: otro texto aleatorio largo.

### 6. Prueba y comparte
1. Abre la dirección en tu celular: debes ver las listas.
2. Entra con tu nombre y tu contraseña, agrega un dulce con foto y guarda.
3. Abajo de todo, en *Soy el organizador*, escribe tu `ADMIN_TOKEN`.
4. Manda la dirección al grupo por WhatsApp. Cada quien entra con su nombre y su contraseña de siempre.

---

## B. Si ya habías publicado la versión anterior (actualizar)
1. En tu repositorio de GitHub, sube y reemplaza estos archivos con los de esta carpeta: `src/worker.js`, `src/seed.js`, `public/index.html` y `wrangler.toml` (en `wrangler.toml` conserva tu Database ID).
2. Cloudflare publica solo en un par de minutos (revisa *Deployments*).
3. **No se pierde nada**: la base de datos conserva listas, fotos y contraseñas. Las tablas nuevas se crean solas y los ajustes toman los valores por defecto (año 2026, primer viernes 30 oct, 6 viernes).
4. `seed.js` solo se usa cuando la base está vacía, así que los datos nuevos que contiene (por ejemplo Santiago y Eder) no se cargan en una base que ya existe. Regístralos desde *Soy el organizador*.

---

## C. Administración (solo tú)
1. Abre la app, baja hasta el final y entra con tu clave en **Soy el organizador**.
2. Pulsa **Abrir administración**. Tiene cuatro bloques:

**Edición actual**
- Año, fecha del primer viernes de regalo (debe ser un viernes) y número de viernes (de 1 a 10). Pulsa *Guardar ajustes*. Los círculos de semanas, las fechas de la portada y los mensajes se actualizan solos.

**Participantes y nombres**
- Cambia el nombre de alguien y pulsa *Guardar nombre*. Su contraseña y su lista no cambian.
- *Contraseña* le pone una nueva (se la mandas por privado).
- *Quitar* borra a la persona, su lista y sus fotos de la edición actual (las copias de años anteriores no se tocan).
- Para agregar a alguien, escribe su nombre y una contraseña inicial y pulsa *Agregar*.

**Cambiar de año**
1. Antes, descarga un respaldo (*Descargar respaldo* en el pie de página).
2. Escribe el año nuevo, el primer viernes y cuántos viernes serán.
3. Marca la casilla si quieres que los dulces de este año queden como punto de partida (las fotos y las marcas de semanas sí se limpian). Si no la marcas, todos empiezan con la lista vacía.
4. Escribe la palabra de confirmación (`ARCHIVAR 2026`, con el año actual) y pulsa el botón.
5. Se guarda una copia completa de la edición actual y empieza la nueva con los mismos participantes y contraseñas. No se puede archivar dos veces el mismo año.

**Ediciones guardadas**
- *Ver* abre esa edición en modo solo lectura, con banner amarillo y botón *Volver a la edición actual*.
- *Descargar copia* baja un archivo con nombres, dulces y marcas de ese año (sin fotos ni contraseñas).
- Cualquier persona con el enlace también puede abrir las ediciones anteriores desde **Ediciones anteriores** en el pie de página.

---

## D. Cuidados
- **Contraseñas**: las de tus amigos siguen siendo las mismas. Tras 10 intentos fallidos desde una misma conexión se bloquea 15 minutos.
- **Fotos de años anteriores**: se guardan en la misma base de datos. Calcula unos 100 KB por foto; con 14 personas y 10 fotos son unos 14 MB por año, muy por debajo del límite gratis de 500 MB.
- **Respaldo**: *Soy el organizador > Descargar respaldo* baja nombres y listas de la edición actual (sin contraseñas ni fotos).
- **Cambios futuros**: cada cambio que confirmes en GitHub se publica solo. Las claves secretas no se tocan.
- **Si una publicación falla**: en tu Worker abre *Deployments* o *Builds*, copia el mensaje de error y pásamelo.
- **Privacidad**: el enlace no aparece en buscadores, pero cualquiera que lo reciba ve las listas, las fotos y las ediciones anteriores. No lo publiques fuera del grupo ni subas fotos con rostros de otras personas.
- **Límite gratis**: 100,000 solicitudes por día al Worker; un grupo de 14 personas no se acerca.
