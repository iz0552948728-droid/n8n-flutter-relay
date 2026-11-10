# Push-уведомления: Android и iPhone

10.11.2026

Relay будит приложение, пока оно открыто. Push нужен, когда приложение закрыто. Push идёт через Firebase Cloud Messaging (проект `buh-app`): один и тот же запрос доставляет на Android, iPhone и в веб-версию, поэтому серверная часть общая.

## Что сделано на сервере

**База.** Таблица `push_tokens (token, user_id, platform, created_at, updated_at)` и функции:

| Функция | Что делает |
| --- | --- |
| `push_token_save(user, token, platform)` | Сохраняет токен; если он уже был у другого пользователя, переписывает на того, кто вошёл последним. Пустой токен пропускает. |
| `push_token_drop(token)` | Удаляет токен: выход или отказ Firebase. |
| `push_token_drop_user(user, keep)` | Удаляет все токены пользователя, кроме `keep`: смена пароля. |

**Register/login** (`AfjbehxN9AbuJ11G`, `/webhook/auth`):

| Запрос | Новые поля в теле | Что происходит |
| --- | --- | --- |
| `login` | `fcm_token`, `fcm_platform` | Токен сохраняется в узле `Generate JWT`. |
| `logout` | `fcm_token` | Токен удаляется. |
| `update-password` | `fcm_token` | Токены других устройств удаляются, токен этого устройства остаётся. |
| `push_token` (новый) | `jwt`, `fcm_token`, `fcm_platform`, `old_fcm_token` | Смена токена без входа. Ответ `{ "success": true, "saved": true }`, при неверном `jwt` — 401. |

`fcm_platform` принимает значения `android`, `ios` или `web`. Если поле не пришло, считается `android`, поэтому нынешнее Android-приложение работает без правок.

**Push send** (`0jF5tusP2rUfzaoS`): подворкфлоу со входом `user_id`, `title`, `body`, `data`. Он шлёт сообщение на все устройства пользователя. В одном сообщении есть блоки `android`, `apns` (iPhone) и `webpush` (веб), так что платформу выбирать не нужно. Заблокированным пользователям push не уходит. Если Firebase отвечает 404 или `UNREGISTERED`, токен удаляется. Ошибки не роняют вызвавший воркфлоу. В `data` передаются строки, например `kind`, `execution_id`: так в будущем можно сделать переход к вопросу по нажатию.

**Question exe** (`NrKEepr4Ig5T5a8J`):
- после `Notify Launcher` идёт push «Новый вопрос по документу» тому, кто запустил обработку;
- после `Notify Admins` идёт push «Вопрос передан вам» администраторам.

Push отправляется без ожидания результата.

## Что нужно сделать вручную

1. **Опубликовать** черновики Register/login и Question exe. Правки сохранены, но в работе пока прежние версии. Порядок важен: сначала Register/login.
2. **Ключ Firebase.** Firebase Console → `buh-app` → Project settings → Service accounts → Generate new private key. В n8n открыть узел `Send FCM` в Push send и создать credential **Google Service Account API**: email и private key из JSON. Включить «Set up for use in HTTP Request node», scope `https://www.googleapis.com/auth/firebase.messaging`. Ключ хранить только в credential.
3. Удалить одноразовый воркфлоу `Push setup SQL` (`BqqCtPiZYQbnS21i`), он больше не нужен.

## iPhone

Сервер для iPhone готов. Нужно выбрать, в каком виде приложение будет на iPhone.

**A. Нативное приложение (App Store / TestFlight).** Нужен Apple Developer Program ($99 в год) и Mac для сборки.
1. developer.apple.com → Keys → создать ключ с Apple Push Notifications service (APNs), скачать `.p8`, записать Key ID и Team ID.
2. Firebase → `buh-app` → Project settings → Cloud Messaging → Apple app configuration: загрузить `.p8`. Добавить iOS-приложение в проект и положить `GoogleService-Info.plist` в `ios/Runner`.
3. Xcode → Runner → Signing & Capabilities: Push Notifications и Background Modes → Remote notifications.
4. В приложении: `requestPermission()`, затем `getToken()`. На iOS токен появляется только после получения APNs-токена, поэтому сначала нужно дождаться `getAPNSToken()`. При входе слать `fcm_platform: "ios"`.

**B. Веб-версия на экране «Домой».** Работает на iOS 16.4 и новее. Apple Developer не нужен.
1. Firebase → Project settings → Cloud Messaging → Web Push certificates: сгенерировать VAPID-ключ.
2. В `web/` положить `firebase-messaging-sw.js`, в `manifest.json` должно быть `"display": "standalone"`.
3. Разрешение на уведомления запрашивать только по нажатию кнопки: iOS не даёт спросить при запуске. Затем вызвать `getToken(vapidKey: ...)` и слать `fcm_platform: "web"`.
4. Push приходит, только если сайт добавлен на экран «Домой» через «Поделиться → На экран „Домой“». В Safari push не работает.

## Правки в приложении (для любой платформы)

- `login`: `fcm_token` уже отправляется; добавить `fcm_platform`.
- `logout`: добавить `fcm_token`.
- `update-password`: добавить `fcm_token`.
- `onTokenRefresh` → `type: "push_token"` с `jwt`, новым `fcm_token`, `old_fcm_token`, `fcm_platform`.

## Проверка

- [ ] Войти с телефона: в `push_tokens` появилась строка с нужными `user_id` и `platform`.
- [ ] Загрузить документ, по которому будет вопрос, и закрыть приложение: push пришёл.
- [ ] Через 15 минут без ответа: push пришёл администратору.
- [ ] Выйти из аккаунта: строка из `push_tokens` исчезла.

## Ещё не подключено

Notifications manager (`Notify Escalated`), Message exe, Error Handler (`Notify Document Failure`), Paul's 1 AO (два узла Receipts). Вызов в каждом месте такой же: узел Execute Workflow → Push send, `waitForSubWorkflow: false`, On Error → Continue.
