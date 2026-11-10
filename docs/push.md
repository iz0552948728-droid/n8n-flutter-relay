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

## Настройка n8n (сделано 10.11.2026)

1. Register/login, Question exe и Push send опубликованы.
2. **Ключ Firebase.** Firebase Console → `buh-app` → Project settings → Service accounts → Generate new private key. В n8n открыть узел `Send FCM` в Push send и создать credential **Google Service Account API**: email и private key из JSON. Включить «Set up for use in HTTP Request node», scope `https://www.googleapis.com/auth/firebase.messaging`. Ключ хранить только в credential.
3. Удалить одноразовый воркфлоу `Push setup SQL` (`BqqCtPiZYQbnS21i`), он больше не нужен.

## iPhone: веб-версия с экрана «Домой»

Выбрана веб-версия (iOS 16.4 и новее, Apple Developer не нужен). Код в `accounting-app`, ветка `claude/tender-edison-v9o0r4`:

- `lib/services/firebase_service.dart` — push на Android, iOS и вебе; токен при входе (`fcm_platform`), при выходе и смене пароля (`fcm_token`), смена токена — `type: push_token`;
- `lib/widgets/push_banner.dart` — кнопка «Включить уведомления» (iPhone даёт спросить только по нажатию) и подсказка «добавьте на экран „Домой“» в Safari;
- `web/firebase-messaging-sw.js` — показ push и открытие приложения по нажатию;
- `.github/workflows/web-deploy.yml` — сборка веба и выкладка на Firebase Hosting: https://buh-app.web.app.

Чтобы заработало:

1. Firebase Console → `buh-app` → Project settings → General: веб-приложение (`</>`), если его нет — добавить. Из его настроек взять `apiKey`, `appId`, `messagingSenderId`.
2. Там же → Cloud Messaging → Web Push certificates → Generate key pair — VAPID-ключ.
3. Firebase Console → Hosting → Get started (включить, команды не нужны).
4. GitHub `accounting-app` → Settings → Secrets and variables → Actions:
   - Variables: `FIREBASE_WEB_API_KEY`, `FIREBASE_WEB_APP_ID`, `FIREBASE_SENDER_ID`, `FIREBASE_VAPID_KEY`;
   - Secret: `FIREBASE_SERVICE_ACCOUNT` — JSON ключа сервисного аккаунта. Можно тот же, что в n8n, добавив ему в Google Cloud → IAM роли Firebase Hosting Admin и API Keys Viewer.
5. Слить ветку в `main` — сборка выложит веб сама.

## Проверка

- [ ] iPhone: открыть https://buh-app.web.app в Safari → «Поделиться» → «На экран „Домой“», запустить с иконки, войти, нажать «Включить» на плашке. В `push_tokens` появилась строка с `platform = web`.
- [ ] Android: войти — строка с `platform = android`.
- [ ] Загрузить документ, по которому будет вопрос, и закрыть приложение: push пришёл.
- [ ] Через 15 минут без ответа: push пришёл администратору.
- [ ] Выйти из аккаунта: строка из `push_tokens` исчезла.

## Ещё не подключено

Notifications manager (`Notify Escalated`), Message exe, Error Handler (`Notify Document Failure`), Paul's 1 AO (два узла Receipts). Вызов в каждом месте такой же: узел Execute Workflow → Push send, `waitForSubWorkflow: false`, On Error → Continue.
