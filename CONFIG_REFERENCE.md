# Wyre — настройка `.env`

Wyre больше не использует Modelence. Все настройки читаются только из файла
`.env` в корне проекта или из обычных переменных окружения процесса. Начните с:

```bash
cp .env.example .env
```

В Windows PowerShell: `Copy-Item .env.example .env`.

## Обязательные значения

| Переменная | Пример | Назначение |
| --- | --- | --- |
| `SITE_URL` | `https://wyre.example.com` | Публичный URL, нужен для email-ссылок и Yandex callback |
| `HTTPS_KEY_FILE` | `./certs/wyre-key.pem` | Приватный ключ TLS; задаётся вместе с `HTTPS_CERT_FILE` для встроенного HTTPS |
| `HTTPS_CERT_FILE` | `./certs/wyre-cert.pem` | TLS-сертификат для встроенного HTTPS-сервера |
| `HTTPS_DEV_CERT_DIR` | `./data/tls` | Каталог постоянного самоподписанного сертификата, автоматически создаваемого в development |
| `TRUST_PROXY` | `true` | Обязательно в production без PEM-файлов, когда TLS завершается на reverse proxy |
| `MONGODB_URI` | `mongodb+srv://...` | Строка внешней MongoDB; обязательна только в production |
| `MONGODB_DB_NAME` | `wyre` | Имя базы |
| `MONGODB_EMBEDDED` | `true` | Автоматически запускать локальную MongoDB в development |
| `MONGODB_DATA_DIR` | `./data/mongodb` | Постоянный каталог встроенной локальной базы |
| `OWNER_EMAIL` | `owner@example.com` | Email владельца Wyre; только он может выдавать административные роли |
| `MONGODB_BINARY_DIR` | `./data/mongodb-binaries` | Локальный кэш исполняемого файла MongoDB |
| `SESSION_SECRET` | случайная строка от 32 символов | Хеширование сессий, OTP и подписей файлов |
| `WEBAUTHN_RP_ID` | `wyre.example.com` | Домен WebAuthn без протокола/порта; пустое значение берётся из `SITE_URL` |
| `WEBAUTHN_ORIGIN` | `https://wyre.example.com` | Точный HTTPS origin WebAuthn; пустое значение берётся из `SITE_URL` |
| `WEBAUTHN_APP_LOCK_MINUTES` | `15` | Через сколько минут бездействия снова запрашивать биометрию приложения |
| `EMAIL_TRANSPORT` | `smtp` | В production обязательно `smtp`; `console` разрешён для локальной разработки |
| `SMTP_FALLBACK_TO_CONSOLE` | `false` | Только development: показать OTP в консоли, если SMTP временно сломан |
| `SMTP_HOST` | `smtp.resend.com` | SMTP-сервер почтового провайдера |
| `SMTP_PORT` | `465` | Порт SMTP |
| `SMTP_SECURE` | `true` | `true` для TLS на 465, обычно `false` для STARTTLS на 587 |
| `SMTP_USER` | `resend` | SMTP login |
| `SMTP_PASS` | `re_...` | SMTP password/API key |
| `EMAIL_FROM` | `Wyre <login@domain.ru>` | Подтверждённый адрес отправителя |

Секрет сессий можно создать командой:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

После первого запуска сервер сам создаёт коллекции и уникальные/TTL-индексы.

WebAuthn работает только на доверенном HTTPS origin. Для локальной разработки
браузер и устройство должны доверять сертификату из `HTTPS_DEV_CERT_DIR`.
`WEBAUTHN_RP_ID` не содержит схему или порт, а `WEBAUTHN_ORIGIN` должен точно
совпадать с адресом в браузере. Сервер хранит только публичный ключ устройства,
счётчик защиты от replay и служебные метаданные — лицо и отпечаток не покидают
системный аутентификатор.

## MongoDB

Для локального запуска ничего устанавливать не нужно. Оставьте:

```dotenv
MONGODB_URI=
MONGODB_EMBEDDED=true
MONGODB_DATA_DIR=./data/mongodb
MONGODB_BINARY_DIR=./data/mongodb-binaries
```

Wyre сам скачает исполняемый файл MongoDB в `MONGODB_BINARY_DIR` при первом
запуске и запустит встроенный процесс. Это настоящая MongoDB с движком
WiredTiger, а не временный mock: данные сохраняются между перезапусками в
`./data/mongodb`. Каталог исключён из git. Если в `MONGODB_URI` указан локальный
`127.0.0.1`, но сервер недоступен, development-режим также автоматически
переключится на встроенную базу.

В production встроенная база намеренно запрещена: там задайте `MONGODB_URI` на
MongoDB Atlas или свой MongoDB-сервер, разместите данные на отдельном постоянном
диске и настройте резервные копии.

Подойдут:

- локальная MongoDB Community Server;
- MongoDB Atlas (управляемая облачная база).

Для Atlas: создайте кластер на <https://cloud.mongodb.com>, затем
Database Access → создайте пользователя, Network Access → разрешите IP сервера,
Connect → Drivers → скопируйте строку в `MONGODB_URI`. Пароль в URI нужно
URL-кодировать. Никакой ручной подготовки коллекций не требуется.

Аккаунт хранится в `wyreUsers`, профиль — в `wyreProfiles`. На нормализованный
email стоят уникальные индексы. Создание auth-пользователя выполняется атомарным
MongoDB `upsert`: повторная регистрация на тот же email всегда открывает прежний
аккаунт и не создаёт новый.

## Отправка email

Рекомендуемый простой вариант — **Resend SMTP**: <https://resend.com>.

1. Добавьте и подтвердите свой домен в Resend → Domains (DNS-записи SPF/DKIM).
2. Создайте API key в Resend → API Keys.
3. Укажите:

```dotenv
EMAIL_TRANSPORT=smtp
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASS=re_ваш_ключ
EMAIL_FROM=Wyre <login@ваш-домен.ru>
```

Подойдёт любой SMTP-провайдер (Brevo, Mailgun, Postmark, собственный SMTP):
меняются только `SMTP_*`. Для локальной разработки оставьте
`EMAIL_TRANSPORT=console` — шестизначный код и magic-link печатаются в терминал.
В production этот режим намеренно запрещён.

Для локальной отладки SMTP можно временно указать:

```dotenv
SMTP_FALLBACK_TO_CONSOLE=true
```

Если SMTP-провайдер отклонит вход или будет недоступен, OTP появится в
терминале и регистрация не оборвётся. Этот fallback работает только при
`NODE_ENV=development`; production никогда не печатает код вместо письма.

Для Яндекс Почты используйте полный адрес ящика как `SMTP_USER`, тот же адрес
в `EMAIL_FROM`, включите доступ почтовых клиентов в настройках ящика и создайте
отдельный пароль приложения типа «Почта». Обычный пароль Yandex ID не подходит.

`OTP_TTL_MINUTES` задаёт срок жизни кода, `OTP_RESEND_SECONDS` — паузу перед
повторной отправкой. Код одноразовый, хранится только как SHA-256-хеш и имеет
лимит пять попыток.

## Yandex ID

Создайте приложение: <https://oauth.yandex.ru/client/new>.

- платформа: «Веб-сервисы»;
- права: `login:email`, `login:info`;
- Callback URI: `${SITE_URL}/auth/yandex/callback`, например
  `https://wyre.example.com/auth/yandex/callback`.

Для текущего компьютера в домашней сети (`192.168.1.7`) и запуска на порту
3000 точное значение должно быть одинаковым в двух местах:

```dotenv
SITE_URL=https://192.168.1.7:3000
```

```text
https://192.168.1.7:3000/auth/yandex/callback
```

Если адрес компьютера в роутере изменится, обновите и `SITE_URL`, и Redirect
URI в приложении Yandex OAuth. Для входа только на самом компьютере можно
вместо этого использовать `https://localhost:3000/auth/yandex/callback`.

Затем заполните:

```dotenv
YANDEX_CLIENT_ID=...
YANDEX_CLIENT_SECRET=...
```

Yandex-пользователь связывается с существующим аккаунтом по подтверждённому
email, поэтому второй аккаунт на тот же email не появляется. Если ключи пустые,
email-вход работает, а `/auth/yandex` честно возвращает 503.

## TURN для звонков

STUN уже задан в коде. Для работы WebRTC за CGNAT/симметричным NAT нужен TURN.
Можно использовать Metered: <https://www.metered.ca/tools/openrelay/> или свой
coturn.

```dotenv
TURN_SERVER_URL=turn:host:80,turns:host:443?transport=tcp
TURN_SERVER_USERNAME=...
TURN_SERVER_CREDENTIAL=...
```

Без TURN звонки в обычных сетях могут работать, но в сложных сетях соединение
может не установиться. DTLS-SRTP шифрование WebRTC включено браузером всегда.

## Вложения и прочее

`UPLOAD_DIR=./uploads` — каталог приватных вложений. Он исключён из git. Для
production каталог должен находиться на постоянном диске и попадать в резервные
копии. Загрузка потоково пишется во временный файл и не держит содержимое в RAM;
скачивание поддерживает HTTP Range для перемотки видео. `MAX_UPLOAD_MB` задаёт
лимит одного файла, по умолчанию `51200` (50 ГБ). Для такого лимита на диске
должно быть достаточно места с учётом временного файла на время загрузки.

`PDF_FONT_FILE` — необязательный путь к TTF/OTF-шрифту с кириллицей для PDF-
экспорта. Если значение пустое, Wyre ищет Arial или DejaVu Sans в стандартных
каталогах Windows, Linux и macOS.

`GROQ_API_KEY` — API-ключ Groq для транскрибации голосовых сообщений.
`AI_TRANSCRIPTION_URL` — OpenAI-compatible endpoint `/audio/transcriptions`;
по умолчанию используется Groq. `AI_TRANSCRIPTION_MODEL` задаёт модель,
по умолчанию `whisper-large-v3-turbo`. Аудио отправляется провайдеру только
после явного нажатия «Расшифровать» участником чата.

`AI_CHAT_URL` и `AI_CHAT_MODEL` задают OpenAI-compatible chat completion
endpoint и модель для перевода, суммаризации чата, семантического поиска,
вариантов коротких ответов, предложения контекстного напоминания и проверки
ссылок на фишинг перед открытием. По умолчанию
это Groq и `openai/gpt-oss-120b`;
используется тот же `GROQ_API_KEY`. Контекст ограничивается сервером только
сообщениями чата, участником которого является вызывающий пользователь.

`AI_ASSISTANT_ENABLED` (по умолчанию `true`) включает персональный чат
«Wyre AI». Ассистент отвечает в отдельном официальном чате: без
`GROQ_API_KEY` он честно сообщает, что не настроен. Персональный контекст
(переписка с AI, профиль, контакты и умеренная выжимка недавних чатов за 30
дней) используется только после явного согласия пользователя кнопками прямо
в чате; согласие хранится в настройках аккаунта.

`AI_IMAGE_ENABLED` (по умолчанию `true`) включает генерацию изображений
в чате «Wyre AI»: пользователь просит картинку, ассистент создаёт её через
бесплатный сервис Pollinations (`AI_IMAGE_URL`, по умолчанию
`https://image.pollinations.ai/prompt`) и отправляет результат обычным
приватным фото-вложением чата. Ключи и регистрация не нужны; при отключении
или недоступности сервиса ассистент отвечает текстом без изображения.

`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` и `VAPID_SUBJECT` включают Web Push.
Ключи генерируются командой `npx web-push generate-vapid-keys`, задаются только
вместе, а `VAPID_SUBJECT` должен быть `mailto:` или `https://`. Без этих
значений push-уведомления отключены, и интерфейс честно сообщает об этом.
Подписка привязана к сессии, удаляется при её завершении, а решение о доставке
принимает только сервер по режиму чата, временному mute и DND.

`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` и `FIREBASE_PRIVATE_KEY`
включают фоновый push для Android-приложения через Firebase Cloud Messaging
(значения берутся из JSON сервисного аккаунта Firebase). Отправка идёт напрямую
по FCM HTTP v1, без Admin SDK. Пустые значения отключают FCM — Web Push выше
продолжает работать. В самом Android-приложении дополнительно нужен файл
`google-services.json` из консоли Firebase в каталоге `mobile-android/app/`:
без него APK собирается и работает, но фоновый push остаётся недоступен.

Идентификация устройств использует отдельную серверную cookie `wyre_device`.
В базе хранится только её хэш и огрублённый сигнал (платформа, семейство
браузера, префикс сети), без canvas/audio-фингерпринта. Это распознаёт
браузерный профиль, поэтому очистка данных браузера, приватный режим, другой
браузер или переустановка создают новую запись: блокировка устройства —
сигнал против злоупотреблений, а не гарантия защиты от переустановки.

Шумоподавление звонков не требует настроек. Браузерный `noiseSuppression`
включён всегда, а дополнительный AudioWorklet-фильтр спектрального гейтинга
включается кнопкой в звонке и работает только там, где браузер поддерживает
AudioWorklet. Это подавление стационарного фона, а не ML-модель уровня
RNNoise/Krisp.

## Запуск

```bash
npm install
npm run dev
```

## Приложение для Windows (desktop/)

Отдельный Electron-оболочка в каталоге `desktop/`, своих переменных `.env` не
имеет — адрес сервера вводится в настройках приложения и хранится в
`%APPDATA%/Wyre/config.json`.

```bash
cd desktop
npm install          # Electron, electron-builder и опциональный nut-js
npm run icon         # пересоздать build/icon.png (иконка Wyre)
npm run dev          # запуск приложения из исходников
npm run dist         # сборка установщика NSIS в desktop/dist-app
```

Из корня проекта: `npm run desktop:dev`, `desktop:start`, `desktop:dist`.
Установщик предлагает выбрать папку установки, создаёт ярлыки и деинсталлятор.
Управление ОС в remote control использует nut-js (необязательная зависимость):
если модуль не установился, приложение работает, но управление ограничено
браузерной поверхностью Wyre. Ограничение Windows: UAC secure desktop не
подпускает программный ввод — честно задокументировано.

## Приложение для Android (mobile-android/)

Нативная WebView-оболочка без сторонних зависимостей; переменных `.env` не
имеет. Адрес сервера вводится при первом запуске (и на офлайн-экране),
хранится в SharedPreferences приложения.

```bash
cd mobile-android
npm run icons      # пересоздать иконки запуска
build.cmd          # сборка dist/Wyre-<версия>.apk (или npm run android:dist из корня)
```

Требования сборочной машины этой конфигурации: JDK 17
(`C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot`), Android SDK в
`D:\wyre\android-sdk` (platform 34 + build-tools 34.0.0), Gradle 8.9 в
`D:\wyre\android-tools`. dl.google.com недоступен из сети, поэтому зависимости
берутся с зеркала Aliyun (`settings.gradle`), а SDK-пакеты ставились через
`android-sdk/mirror-proxy.cjs` (зеркало Tencent). APK подписан ключом
`mobile-android/wyre.keystore` (пароль `wyre-family`). Фоновых push нет (FCM
не подключён) — уведомления только при открытом приложении.

Уведомления Windows в приложении идут через живой Socket.IO (Web Push в
Electron недоступен): при росте непрочитанных в скрытом окне показывается
системный toast. Офлайн-режим: service worker отдаёт последнюю оболочку,
снимок последних данных хранится в localStorage, экрана «нет соединения» нет —
тихая заставка и автоматическое переподключение. Журналы приложения:
`%APPDATA%/Wyre/logs` (ротация 7 дней).

Полная очистка аккаунтов и всех их данных:

```bash
npm run reset:accounts              # пробный запуск, только показывает счётчики
node dist/reset-accounts.mjs --confirm   # фактическое удаление
```

Скрипт удаляет пользователей, сессии, OTP, устройства, профили, настройки,
чаты, сообщения, звонки, каналы, истории, журнал модерации и приватные
вложения. Операция необратима: сделайте резервную копию `MONGODB_DATA_DIR` и
`UPLOAD_DIR` заранее.

Выдача роли существующему аккаунту:

```bash
npm run grant:role                                   # список аккаунтов и ролей
node dist/grant-role.mjs you@example.com owner        # выдать роль
```

Роль владельца обычно выводится из `OWNER_EMAIL`, поэтому этот скрипт нужен для
самой первой установки. После выдачи `owner` пропишите тот же email в
`OWNER_EMAIL`, иначе роль может быть переопределена при следующем входе.

Выдача бейджа Dev или Official:

```bash
npm run grant:badge                                  # список аккаунтов и бейджей
node dist/grant-badge.mjs you@example.com dev        # бейдж разработчика
node dist/grant-badge.mjs you@example.com official   # официальный бейдж
node dist/grant-badge.mjs you@example.com none       # снять бейдж
```

Production:

```bash
npm run build
npm start
```

Проверка: `GET /api/health` должна вернуть `{ "ok": true }`.

### Запуск в локальной сети

Сервер слушает `0.0.0.0`, поэтому отдельный флаг запуска не нужен. При текущем
адресе компьютера другие устройства в той же сети открывают:

```text
https://192.168.1.7:3000
```

При запуске Wyre печатает все найденные LAN-адреса. Если страница не открывается,
разрешите `node.exe` для частных сетей в Windows Defender Firewall и проверьте,
что устройства подключены к одному роутеру. DHCP может поменять адрес; удобнее
закрепить `192.168.1.7` за компьютером в настройках роутера.

Wyre всегда использует публичный `https://` URL. В development без указанных
PEM-файлов сервер автоматически создаёт постоянные `wyre-dev-key.pem` и
`wyre-dev-cert.pem` в `HTTPS_DEV_CERT_DIR`. Самоподписанный сертификат нужно
один раз добавить в доверенные на компьютере и телефоне; иначе браузер не
считает origin безопасным и не даёт доступ к камере, микрофону и экрану.

Чтобы использовать собственный сертификат, положите PEM-файлы вне публичной
папки и заполните:

```dotenv
SITE_URL=https://192.168.1.7:3000
HTTPS_KEY_FILE=./certs/wyre-key.pem
HTTPS_CERT_FILE=./certs/wyre-cert.pem
```

Обе HTTPS-переменные задаются только вместе. Сертификат должен содержать адрес
или доменное имя, по которому телефон открывает Wyre, а сам телефон должен ему
доверять. Бесплатные варианты для домашней сети: локальный сертификат через
`mkcert` с установкой корневого сертификата на телефон либо HTTPS-туннель с
публичным доменом. При смене `SITE_URL` также замените Yandex Redirect URI на
`${SITE_URL}/auth/yandex/callback`.

В production `SITE_URL` обязан начинаться с `https://`. Если HTTPS завершается
на Caddy, Nginx или другом reverse proxy, оставьте PEM-переменные пустыми и
задайте `TRUST_PROXY=true`. Без PEM-файлов и доверенного proxy приложение
откажется запускаться, чтобы случайно не открыть небезопасный HTTP origin.
