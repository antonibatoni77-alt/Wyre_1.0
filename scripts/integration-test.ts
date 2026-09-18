import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { generate as generateCertificate } from 'selfsigned';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io } from 'socket.io-client';
import { generate as generateTotp } from 'otplib';

const port = 43127;
const transcriptionPort = 43128;
const pushPort = 43129;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const baseUrl = `https://127.0.0.1:${port}`;
const uploadDir = path.resolve(process.cwd(), '.integration-uploads');
const embeddedDataDir = path.resolve(process.cwd(), '.integration-mongodb');
const tlsDir = path.resolve(process.cwd(), '.integration-tls');
const mongoBinaryDir = path.resolve(process.cwd(), 'data/mongodb-binaries');
let server: ChildProcessWithoutNullStreams | null = null;
let output = '';
let transcriptionRequests = 0;
let translationRequests = 0;
let aiAssistantRequests = 0;
let phishingRequests = 0;
let pushDeliveries = 0;
let pushGoneRequests = 0;

type JsonResponse<T> = { status: number; body: T; cookie?: string; cookies: string[] };

async function json<T>(pathname: string, body?: unknown, cookie?: string): Promise<JsonResponse<T>> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : []);
  const sessionCookie = setCookies.map((value) => value.split(';')[0]).find((value) => value.startsWith('wyre_session='));
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as T,
    cookie: sessionCookie ?? setCookies[0]?.split(';')[0],
    cookies: setCookies.map((value) => value.split(';')[0]),
  };
}

async function rpc<T>(cookie: string, kind: 'query' | 'mutation' | 'call', method: string, args: unknown = {}) {
  const response = await json<{ data?: T; error?: { message: string } }>(`/api/rpc/${kind}`, { method, args }, cookie);
  assert.equal(response.status, 200, response.body.error?.message);
  return response.body.data as T;
}

async function rpcError(cookie: string, kind: 'query' | 'mutation' | 'call', method: string, args: unknown = {}) {
  const response = await json<{ error?: { message: string; code: string } }>(`/api/rpc/${kind}`, { method, args }, cookie);
  assert.notEqual(response.status, 200);
  return response;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await json<{ ok: boolean }>('/api/health');
      if (response.status === 200 && response.body.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }
  throw new Error(`Server did not start:\n${output}`);
}

async function codeFor(email: string, afterIndex = 0) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\[Wyre development OTP\\] ${escaped}: (\\d{6})`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = output.slice(afterIndex).match(pattern);
    if (match) return match[1];
    await delay(50);
  }
  throw new Error(`OTP for ${email} was not logged`);
}

async function register(email: string, name: string, username: string) {
  const outputStart = output.length;
  const sent = await json<{ ok: true }>('/api/auth/send-code', { email });
  assert.equal(sent.status, 200);
  const verified = await json<{ ok: true }>('/api/auth/verify-code', { email, code: await codeFor(email, outputStart) });
  assert.equal(verified.status, 200);
  assert.ok(verified.cookie);
  const result = await rpc<{ existingAccount: boolean }>(verified.cookie, 'call', 'wyre.completeSignup', { name, username });
  assert.equal(result.existingAccount, false);
  const phoneStep = await rpc<{ needsPhoneSetup: boolean; profile: unknown }>(verified.cookie, 'query', 'wyre.session');
  assert.equal(phoneStep.needsPhoneSetup, true);
  assert.equal(phoneStep.profile, null);
  await rpc(verified.cookie, 'mutation', 'wyre.setPhone', { phone: null });
  return verified.cookie;
}

async function run() {
  const transcriptionServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/chat/completions') {
        assert.equal(request.headers.authorization, 'Bearer integration-groq-key');
        assert.match(request.headers['content-type'] ?? '', /application\/json/);
        const payload = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { content: string }[] };
        const system = payload.messages[0]?.content ?? '';
        if (system.includes('WYRE_SUMMARY')) {
          aiAssistantRequests += 1;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: 'Семья договорилась об ужине в семь.' } }] }));
          return;
        }
        if (system.includes('WYRE_SEMANTIC_SEARCH')) {
          aiAssistantRequests += 1;
          const input = JSON.parse(payload.messages.at(-1)?.content ?? '{}') as { messages?: { id: string; text: string }[] };
          const match = input.messages?.find((message) => message.text.includes('Family dinner'));
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ids: match ? [match.id] : [] }) } }] }));
          return;
        }
        if (system.includes('WYRE_SMART_REPLIES')) {
          aiAssistantRequests += 1;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(['Буду вовремя', 'Спасибо!', 'Давайте в семь']) } }] }));
          return;
        }
        if (system.includes('WYRE_CONTEXT_REMINDER')) {
          aiAssistantRequests += 1;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: 'Подготовиться к семейному ужину', remindAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }) } }] }));
          return;
        }
        if (system.includes('WYRE_PHISHING_CHECK')) {
          phishingRequests += 1;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ level: 'low', reason: 'Домен и описание не содержат явных признаков подмены' }) } }] }));
          return;
        }
        const source = payload.messages.at(-1)?.content;
        translationRequests += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: source === 'Family dinner is at seven' ? 'Семейный ужин в семь' : 'Перевод недоступен' } }] }));
        return;
      }
      assert.equal(request.headers.authorization, 'Bearer integration-groq-key');
      transcriptionRequests += 1;
      assert.match(request.headers['content-type'] ?? '', /multipart\/form-data/);
      assert.ok(Buffer.concat(chunks).includes(Buffer.from('voice-bytes')));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ text: 'Расшифрованное семейное сообщение' }));
    });
  });
  await new Promise<void>((resolve) => transcriptionServer.listen(transcriptionPort, '127.0.0.1', resolve));

  // web-push always speaks HTTPS, so the mock endpoint uses a throwaway certificate.
  const pushCertificate = generateCertificate([{ name: 'commonName', value: '127.0.0.1' }], { days: 2, keySize: 2048 });
  const pushServer = createHttpsServer({ key: pushCertificate.private, cert: pushCertificate.cert }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/push-gone') {
        pushGoneRequests += 1;
        response.writeHead(410);
        response.end();
        return;
      }
      pushDeliveries += 1;
      assert.match(request.headers.authorization ?? '', /^vapid /i);
      assert.ok(Buffer.concat(chunks).length > 0);
      response.writeHead(201);
      response.end();
    });
  });
  await new Promise<void>((resolve) => pushServer.listen(pushPort, '127.0.0.1', resolve));

  const mongo = await MongoMemoryServer.create({ binary: { downloadDir: mongoBinaryDir } });
  const mongoClient = new MongoClient(mongo.getUri());
  await mongoClient.connect();
  const dbName = 'wyre_integration';

  try {
    server = spawn(process.execPath, ['dist/server/app.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        SITE_URL: baseUrl,
        HTTPS_DEV_CERT_DIR: tlsDir,
        MONGODB_URI: mongo.getUri(),
        MONGODB_DB_NAME: dbName,
        SESSION_SECRET: 'integration-test-secret-with-more-than-32-characters',
        OWNER_EMAIL: 'alice@example.com',
        EMAIL_TRANSPORT: 'console',
        YANDEX_CLIENT_ID: '',
        YANDEX_CLIENT_SECRET: '',
        OTP_RESEND_SECONDS: '15',
        UPLOAD_DIR: uploadDir,
        GROQ_API_KEY: 'integration-groq-key',
        AI_TRANSCRIPTION_URL: `http://127.0.0.1:${transcriptionPort}/audio/transcriptions`,
        AI_CHAT_URL: `http://127.0.0.1:${transcriptionPort}/chat/completions`,
        VAPID_PUBLIC_KEY: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
        VAPID_PRIVATE_KEY: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls',
        VAPID_SUBJECT: 'mailto:integration@example.com',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    server.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await waitForServer();

    const anonymous = await rpc<{ authenticated: boolean }>('', 'query', 'wyre.session');
    assert.equal(anonymous.authenticated, false);
    const disposable = await json<{ error: { code: string } }>('/api/auth/send-code', { email: 'test@mailinator.com' });
    assert.equal(disposable.status, 400);
    const yandex = await fetch(`${baseUrl}/auth/yandex`, { redirect: 'manual' });
    assert.equal(yandex.status, 503);

    const aliceEmail = 'alice@example.com';
    const bobEmail = 'bob@example.com';
    const charlieEmail = 'charlie@example.com';
    let aliceCookie = await register(aliceEmail, 'Алиса', 'alice_wyre');
    const bobCookie = await register(bobEmail, 'Боб', 'bob_wyre');
    const charlieCookie = await register(charlieEmail, 'Чарли', 'charlie_wyre');

    const aliceSession = await rpc<{ profile: { username: string } }>(aliceCookie, 'query', 'wyre.session');
    assert.equal(aliceSession.profile.username, 'alice_wyre');

    // Re-registering one email must reuse the same auth user and profile.
    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: aliceEmail });
    const repeatOutputStart = output.length;
    assert.equal((await json('/api/auth/send-code', { email: aliceEmail })).status, 200);
    const repeat = await json<{ ok: true }>('/api/auth/verify-code', {
      email: aliceEmail,
      code: await codeFor(aliceEmail, repeatOutputStart),
    });
    assert.ok(repeat.cookie);
    const pending = await rpc<{ needsChallenge: boolean }>(repeat.cookie, 'query', 'wyre.session');
    assert.equal(pending.needsChallenge, true);
    const existing = await rpc<{ existingAccount: boolean }>(repeat.cookie, 'call', 'wyre.completeSignup', {
      name: 'Не создаётся',
      username: 'unused_handle',
    });
    assert.equal(existing.existingAccount, true);
    aliceCookie = repeat.cookie;
    assert.equal(await mongoClient.db(dbName).collection('wyreUsers').countDocuments({ email: aliceEmail }), 1);
    assert.equal(await mongoClient.db(dbName).collection('wyreProfiles').countDocuments({ email: aliceEmail }), 1);

    // Normal login enforces username and the bound phone on the server.
    await rpc(aliceCookie, 'mutation', 'wyre.setPhone', { phone: '+7 (999) 123-45-67' });
    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: aliceEmail });
    const loginOutputStart = output.length;
    assert.equal((await json('/api/auth/send-code', { email: aliceEmail })).status, 200);
    const login = await json<{ ok: true }>('/api/auth/verify-code', {
      email: aliceEmail,
      code: await codeFor(aliceEmail, loginOutputStart),
    });
    assert.ok(login.cookie);
    const challenged = await rpc<{ needsChallenge: boolean; requiresPhone: boolean }>(login.cookie, 'query', 'wyre.session');
    assert.equal(challenged.needsChallenge, true);
    assert.equal(challenged.requiresPhone, true);
    const usernameStep = await rpc<{ done: boolean; requiresPhone: boolean }>(
      login.cookie,
      'mutation',
      'wyre.verifyUsername',
      { username: '@alice_wyre' },
    );
    assert.equal(usernameStep.done, false);
    assert.equal(usernameStep.requiresPhone, true);
    await rpc(login.cookie, 'mutation', 'wyre.verifyPhone', { phone: '8 (999) 123-45-67' });
    const verifiedSession = await rpc<{ profile: { username: string } }>(login.cookie, 'query', 'wyre.session');
    assert.equal(verifiedSession.profile.username, 'alice_wyre');
    aliceCookie = login.cookie;

    const peopleForAlice = await rpc<{ userId: string; username: string }[]>(aliceCookie, 'query', 'wyre.searchPeople', { query: 'bob' });
    const peopleForBob = await rpc<{ userId: string; username: string }[]>(bobCookie, 'query', 'wyre.searchPeople', { query: 'alice' });
    assert.equal(peopleForAlice.length, 1);
    assert.equal(peopleForBob.length, 1);

    // Avatar upload is private, bounded and visible through people/profile APIs.
    const avatarTicket = await rpc<{ url: string; fields: Record<string, string>; filePath: string }>(aliceCookie, 'mutation', 'wyre.requestAvatarUpload', {
      fileName: 'avatar.png', fileSize: 8, contentType: 'image/png',
    });
    const avatarForm = new FormData();
    for (const [key, value] of Object.entries(avatarTicket.fields)) avatarForm.append(key, value);
    avatarForm.append('file', new Blob(['png-data'], { type: 'image/png' }), 'avatar.png');
    assert.equal((await fetch(`${baseUrl}${avatarTicket.url}`, { method: 'POST', headers: { Cookie: aliceCookie }, body: avatarForm })).status, 201);
    await rpc(aliceCookie, 'mutation', 'wyre.setAvatar', { filePath: avatarTicket.filePath, mimeType: 'image/png' });
    const bobPeopleView = await rpc<{ userId: string; avatarUrl?: string }[]>(bobCookie, 'query', 'wyre.searchPeople', { query: 'alice' });
    assert.ok(bobPeopleView[0]?.avatarUrl);
    const alicePublicProfile = await rpc<{ avatarUrl?: string }>(bobCookie, 'query', 'wyre.userProfile', { userId: bobPeopleView[0].userId });
    assert.ok(alicePublicProfile.avatarUrl);
    // A stranger must still be able to open a public card, but blocked users must not.
    assert.equal((await rpc<{ isSelf: boolean; canMessage: boolean }>(charlieCookie, 'query', 'wyre.userProfile', { userId: bobPeopleView[0].userId })).isSelf, false);
    assert.equal((await rpc<{ isSelf: boolean }>(aliceCookie, 'query', 'wyre.userProfile', { userId: bobPeopleView[0].userId })).isSelf, true);

    const [fromAlice, fromBob] = await Promise.all([
      rpc<{ chatId: string }>(aliceCookie, 'mutation', 'wyre.openDirectChat', { peerId: peopleForAlice[0].userId }),
      rpc<{ chatId: string }>(bobCookie, 'mutation', 'wyre.openDirectChat', { peerId: peopleForBob[0].userId }),
    ]);
    assert.equal(fromAlice.chatId, fromBob.chatId);
    const chatId = fromAlice.chatId;
    const voiceTicket = await rpc<{ url: string; fields: Record<string, string>; filePath: string }>(aliceCookie, 'mutation', 'wyre.requestAttachmentUpload', { chatId, fileName: 'voice.webm', fileSize: 11, contentType: 'audio/webm' });
    const voiceForm = new FormData();
    for (const [key, value] of Object.entries(voiceTicket.fields)) voiceForm.append(key, value);
    // MediaRecorder reports codec parameters, so the server must compare base MIME types.
    voiceForm.append('file', new Blob(['voice-bytes'], { type: 'audio/webm;codecs=opus' }), 'voice.webm');
    assert.equal((await fetch(`${baseUrl}${voiceTicket.url}`, { method: 'POST', headers: { Cookie: aliceCookie }, body: voiceForm })).status, 201);
    const voiceRoot = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: '', kind: 'voice', duration: 5, filePath: voiceTicket.filePath, mimeType: 'audio/webm', fileName: 'voice.webm' });
    const voiceReply = await rpc<{ messageId: string }>(bobCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Ответ голосом', kind: 'voice', duration: 4, replyToId: voiceRoot.messageId });
    const voiceThread = (await rpc<{ id: string; replyToKind?: string; voiceThreadRootId?: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId })).find((message) => message.id === voiceReply.messageId);
    assert.equal(voiceThread?.replyToKind, 'voice');
    assert.equal(voiceThread?.voiceThreadRootId, voiceRoot.messageId);
    assert.equal((await rpc<{ transcription: string }>(bobCookie, 'mutation', 'wyre.transcribeVoiceMessage', { messageId: voiceRoot.messageId })).transcription, 'Расшифрованное семейное сообщение');
    assert.equal((await rpc<{ transcription: string }>(aliceCookie, 'mutation', 'wyre.transcribeVoiceMessage', { messageId: voiceRoot.messageId })).transcription, 'Расшифрованное семейное сообщение');
    assert.equal(transcriptionRequests, 1);
    assert.equal((await rpc<{ id: string; transcription?: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId })).find((message) => message.id === voiceRoot.messageId)?.transcription, 'Расшифрованное семейное сообщение');
    const englishMessage = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Family dinner is at seven', kind: 'text' });
    assert.equal((await rpc<{ translation: string }>(bobCookie, 'mutation', 'wyre.translateMessage', { messageId: englishMessage.messageId, targetLanguage: 'ru' })).translation, 'Семейный ужин в семь');
    assert.equal((await rpc<{ translation: string }>(aliceCookie, 'mutation', 'wyre.translateMessage', { messageId: englishMessage.messageId, targetLanguage: 'ru' })).translation, 'Семейный ужин в семь');
    assert.equal(translationRequests, 1);
    assert.equal((await rpc<{ id: string; translation?: string }[]>(bobCookie, 'query', 'wyre.listMessages', { chatId })).find((message) => message.id === englishMessage.messageId)?.translation, 'Семейный ужин в семь');
    const summary = await rpc<{ summary: string; messageCount: number }>(bobCookie, 'mutation', 'wyre.summarizeChat', { chatId });
    assert.equal(summary.summary, 'Семья договорилась об ужине в семь.');
    assert.ok(summary.messageCount > 0);
    const emptySummary = await rpc<{ summary: string; messageCount: number }>(bobCookie, 'mutation', 'wyre.summarizeChat', { chatId });
    assert.equal(emptySummary.messageCount, 0);
    const semantic = await rpc<{ results: { id: string; text: string }[] }>(bobCookie, 'mutation', 'wyre.semanticSearchMessages', { chatId, query: 'Во сколько семейный ужин?' });
    assert.equal(semantic.results[0]?.id, englishMessage.messageId);
    const smartReplies = await rpc<{ replies: string[] }>(bobCookie, 'mutation', 'wyre.suggestChatReplies', { chatId });
    assert.deepEqual(smartReplies.replies, ['Буду вовремя', 'Спасибо!', 'Давайте в семь']);
    assert.equal((await rpcError(charlieCookie, 'mutation', 'wyre.semanticSearchMessages', { chatId, query: 'ужин' })).status, 400);
    const reminderSuggestion = await rpc<{ text: string; remindAt: string }>(bobCookie, 'mutation', 'wyre.suggestReminder', { messageId: englishMessage.messageId });
    assert.equal(reminderSuggestion.text, 'Подготовиться к семейному ужину');
    const reminder = await rpc<{ reminderId: string }>(bobCookie, 'mutation', 'wyre.saveReminder', { messageId: englishMessage.messageId, ...reminderSuggestion });
    assert.equal((await rpc<{ id: string }[]>(bobCookie, 'query', 'wyre.reminders', { chatId }))[0]?.id, reminder.reminderId);
    assert.equal((await rpc<unknown[]>(aliceCookie, 'query', 'wyre.reminders', { chatId })).length, 0);
    assert.equal((await rpcError(charlieCookie, 'mutation', 'wyre.suggestReminder', { messageId: englishMessage.messageId })).status, 400);
    await mongoClient.db(dbName).collection('wyreReminders').updateOne({ _id: new ObjectId(reminder.reminderId) }, { $set: { remindAt: new Date(Date.now() - 1000) } });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const stored = await mongoClient.db(dbName).collection('wyreReminders').findOne({ _id: new ObjectId(reminder.reminderId) });
      if (stored?.notifiedAt) break;
      await delay(1000);
    }
    assert.ok((await mongoClient.db(dbName).collection('wyreReminders').findOne({ _id: new ObjectId(reminder.reminderId) }))?.notifiedAt);
    assert.equal((await rpc<{ due: boolean }[]>(bobCookie, 'query', 'wyre.reminders', { chatId }))[0]?.due, true);
    await rpc(bobCookie, 'mutation', 'wyre.completeReminder', { reminderId: reminder.reminderId });
    assert.equal((await rpc<unknown[]>(bobCookie, 'query', 'wyre.reminders', { chatId })).length, 0);
    const firstNote = await rpc<{ version: number }>(bobCookie, 'mutation', 'wyre.updateSharedNote', { chatId, content: 'Купить продукты к ужину', expectedVersion: 0 });
    assert.equal(firstNote.version, 1);
    assert.deepEqual(await rpc(aliceCookie, 'query', 'wyre.sharedNote', { chatId }), { content: 'Купить продукты к ужину', version: 1, updatedAt: (await rpc<{ updatedAt: string }>(aliceCookie, 'query', 'wyre.sharedNote', { chatId })).updatedAt });
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.updateSharedNote', { chatId, content: 'Устаревшая версия', expectedVersion: 0 })).body.error?.code, 'VERSION_CONFLICT');
    assert.equal((await rpc<{ version: number }>(aliceCookie, 'mutation', 'wyre.updateSharedNote', { chatId, content: 'Купить продукты и позвонить родным', expectedVersion: 1 })).version, 2);
    assert.equal((await rpcError(charlieCookie, 'query', 'wyre.sharedNote', { chatId })).status, 400);
    assert.equal(aiAssistantRequests, 4);
    await rpc(aliceCookie, 'mutation', 'wyre.updateSettings', { autoDnd: true, timeZone: 'UTC' });
    await mongoClient.db(dbName).collection('wyreSettings').updateOne({ userId: peopleForBob[0].userId }, { $set: { autoDndUpdatedAt: null, dnd: false } });
    let autoDndSettings: { dnd?: boolean; dndFrom?: string; dndTo?: string; autoDndUpdatedAt?: string } | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      autoDndSettings = await rpc(aliceCookie, 'query', 'wyre.settings');
      if (autoDndSettings.dnd && autoDndSettings.autoDndUpdatedAt) break;
      await delay(1000);
    }
    assert.equal(autoDndSettings?.dnd, true);
    assert.match(autoDndSettings?.dndFrom ?? '', /^\d{2}:00$/);
    assert.match(autoDndSettings?.dndTo ?? '', /^\d{2}:00$/);
    const scheduled = await rpc<{ scheduledMessageId: string }>(aliceCookie, 'mutation', 'wyre.scheduleMessage', {
      chatId, text: 'Запланированное сообщение', scheduledAt: new Date(Date.now() + 60 * 60 * 1000 + 10_000).toISOString(),
    });
    assert.equal((await rpc<{ id: string }[]>(aliceCookie, 'query', 'wyre.scheduledMessages', { chatId })).length, 1);
    await mongoClient.db(dbName).collection('wyreScheduledMessages').updateOne(
      { _id: new ObjectId(scheduled.scheduledMessageId) },
      { $set: { scheduledAt: new Date(Date.now() - 1000) } },
    );
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const scheduledMessages = await rpc<{ text: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId });
      if (scheduledMessages.some((message) => message.text === 'Запланированное сообщение')) break;
      await delay(1000);
    }
    const deliveredScheduled = await rpc<{ text: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId });
    assert.ok(deliveredScheduled.some((message) => message.text === 'Запланированное сообщение'));
    await rpc(aliceCookie, 'mutation', 'wyre.saveDraft', { chatId, text: 'Черновик между устройствами' });
    assert.equal(await rpc<string>(aliceCookie, 'query', 'wyre.draft', { chatId }), 'Черновик между устройствами');
    await rpc(aliceCookie, 'mutation', 'wyre.clearDraft', { chatId });
    assert.equal(await rpc<string>(aliceCookie, 'query', 'wyre.draft', { chatId }), '');

    // Moderation is server-authorized: ordinary users cannot open it, while the configured owner can issue roles/badges/warnings with an audit log.
    const deniedAdmin = await json<{ error: { code: string } }>(
      '/api/rpc/query',
      { method: 'wyre.adminUsers', args: { query: '' } },
      bobCookie,
    );
    assert.equal(deniedAdmin.status, 403);
    const adminUsers = await rpc<{ id: string; username: string }[]>(aliceCookie, 'query', 'wyre.adminUsers', { query: 'bob' });
    assert.equal(adminUsers.length, 1);
    const bobProfileId = adminUsers[0].id;
    await rpc(aliceCookie, 'mutation', 'wyre.issueWarning', { targetId: bobProfileId, reason: 'Проверочное предупреждение' });
    await rpc(aliceCookie, 'mutation', 'wyre.setUserBadge', { targetId: bobProfileId, badge: 'official' });
    await rpc(aliceCookie, 'mutation', 'wyre.setUserRole', { targetId: bobProfileId, role: 'moderator' });
    const moderatedBob = (await rpc<{ warnings: number; badge?: string; role: string }[]>(aliceCookie, 'query', 'wyre.adminUsers', { query: 'bob' }))[0];
    assert.equal(moderatedBob.warnings, 1);
    assert.equal(moderatedBob.badge, 'official');
    assert.equal(moderatedBob.role, 'moderator');
    const publicBob = (await rpc<{ badge?: string; warnings: { reason: string }[] }[]>(aliceCookie, 'query', 'wyre.searchPeople', { query: 'bob' }))[0];
    assert.equal(publicBob.badge, 'official');
    assert.equal(publicBob.warnings[0]?.reason, 'Проверочное предупреждение');
    assert.equal((await rpc<unknown[]>(aliceCookie, 'query', 'wyre.adminLog')).length, 3);

    // Timed warnings: a duration is stored, expiry stops counting, and staff can remove a warning early.
    const timed = await rpc<{ warnings: number; expiresAt: string }>(aliceCookie, 'mutation', 'wyre.issueWarning', { targetId: bobProfileId, reason: 'Сроковое предупреждение', durationMinutes: 1440 });
    assert.equal(timed.warnings, 2);
    assert.ok(new Date(timed.expiresAt).getTime() > Date.now());
    const bobWithDetails = (await rpc<{ warnings: number; warningDetails?: { reason: string; issuedAt: string; expiresAt: string | null }[] }[]>(aliceCookie, 'query', 'wyre.adminUsers', { query: 'bob' }))[0];
    assert.equal(bobWithDetails.warningDetails?.length, 2);
    const expiring = bobWithDetails.warningDetails?.find((warning) => warning.expiresAt);
    assert.equal(expiring?.reason, 'Сроковое предупреждение');
    await rpc(aliceCookie, 'mutation', 'wyre.removeWarning', { targetId: bobProfileId, issuedAt: expiring!.issuedAt });
    assert.equal((await rpc<{ warnings: number }[]>(aliceCookie, 'query', 'wyre.adminUsers', { query: 'bob' }))[0].warnings, 1);
    await rpc(aliceCookie, 'mutation', 'wyre.issueWarning', { targetId: bobProfileId, reason: 'Короткое предупреждение', durationMinutes: 0.001 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await rpc<{ warnings: number }[]>(aliceCookie, 'query', 'wyre.adminUsers', { query: 'bob' }))[0].warnings, 1);
    await rpc(aliceCookie, 'mutation', 'wyre.issueWarning', { targetId: bobProfileId, reason: 'Второе постоянное предупреждение' });

    // Service chats: every user gets the official Wyre (support) and Wyre AI chats.
    const serviceChats = await rpc<{ id: string; name: string; badge?: string; service?: boolean }[]>(aliceCookie, 'query', 'wyre.listChats');
    const wyreChat = serviceChats.find((chat) => chat.name === 'Wyre');
    const wyreAiChat = serviceChats.find((chat) => chat.name === 'Wyre AI');
    assert.ok(wyreChat?.service && wyreChat.badge === 'official', 'чат Wyre должен быть официальным сервисным чатом');
    assert.ok(wyreAiChat?.service && wyreAiChat.badge === 'official', 'чат Wyre AI должен быть официальным сервисным чатом');
    const wyreSearch = await rpc<{ name: string }[]>(aliceCookie, 'query', 'wyre.searchPeople', { query: 'wyre' });
    assert.ok(!wyreSearch.some((person) => person.name === 'Wyre' || person.name === 'Wyre AI'), 'сервисные аккаунты не должны находиться поиском');
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.startCall', { chatId: wyreChat!.id, kind: 'audio' })).status, 400, 'звонок в сервисный чат запрещён');
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId: wyreChat!.id, text: 'кнопки', kind: 'actions' })).status, 400, 'клиент не может отправлять сообщения с кнопками');

    // AI consent: the buttons arrive with the chat, accepting stores consent and unlocks the greeting.
    const aiMessages = await rpc<{ id: string; kind: string; text: string; actions?: { id: string; label: string }[]; usedActionId?: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId: wyreAiChat!.id });
    const consentMessage = aiMessages.find((message) => message.kind === 'actions');
    assert.ok(consentMessage?.actions?.some((action) => action.id === 'ai-consent:accept'), 'сообщение-согласие с кнопками должно быть первым в чате');
    await rpc(aliceCookie, 'mutation', 'wyre.invokeMessageAction', { messageId: consentMessage!.id, actionId: 'ai-consent:accept' });
    const afterConsent = await rpc<{ id: string; text: string; usedActionId?: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId: wyreAiChat!.id });
    assert.equal(afterConsent.find((message) => message.id === consentMessage!.id)?.usedActionId, 'ai-consent:accept');
    assert.ok(afterConsent.some((message) => message.text.includes('Вы улучшили ваш персональный AI')));
    assert.ok(afterConsent.some((message) => message.text.includes('твой персональный помощник')));
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.invokeMessageAction', { messageId: consentMessage!.id, actionId: 'ai-consent:decline' })).status, 400, 'повторное нажатие кнопок отклоняется');

    // Wyre AI answers user messages: a real reply with a configured key, an honest notice without one.
    const aiBefore = (await rpc<{ mine: boolean; text: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId: wyreAiChat!.id })).filter((message) => !message.mine).length;
    await rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId: wyreAiChat!.id, text: 'Привет! Кратко: что ты умеешь?' });
    let aiReplies: { text: string }[] = [];
    for (let attempt = 0; attempt < 45 && !aiReplies.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const allAi = await rpc<{ mine: boolean; text: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId: wyreAiChat!.id });
      aiReplies = allAi.filter((message) => !message.mine).slice(aiBefore);
    }
    assert.ok(aiReplies.length >= 1, 'Wyre AI должен ответить в чате (или честно сообщить, что не настроен)');
    assert.ok(aiReplies[0].text.trim().length > 0);

    // Support: staff replies land in the user's Wyre chat and the user can write back.
    await rpc(aliceCookie, 'mutation', 'wyre.adminSendSupportMessage', { userId: peopleForAlice[0].userId, text: 'Ответ поддержки' });
    const bobServiceChats = await rpc<{ id: string; name: string; last: string; unread: number }[]>(bobCookie, 'query', 'wyre.listChats');
    const bobWyreChat = bobServiceChats.find((chat) => chat.name === 'Wyre');
    assert.equal(bobWyreChat?.last, 'Ответ поддержки');
    assert.ok((bobWyreChat?.unread ?? 0) >= 1);
    await rpc(bobCookie, 'mutation', 'wyre.sendMessage', { chatId: bobWyreChat!.id, text: 'Вопрос поддержке' });
    const supportMessages = await rpc<{ fromSupport: boolean; text: string }[]>(aliceCookie, 'query', 'wyre.adminSupportMessages', { userId: peopleForAlice[0].userId });
    assert.ok(supportMessages.some((entry) => entry.fromSupport && entry.text === 'Ответ поддержки'));
    assert.ok(supportMessages.some((entry) => !entry.fromSupport && entry.text === 'Вопрос поддержке'));
    const threads = await rpc<{ userId: string; last: string }[]>(aliceCookie, 'query', 'wyre.adminSupportThreads', {});
    assert.ok(threads.some((thread) => thread.userId === peopleForAlice[0].userId && thread.last === 'Вопрос поддержке'));

    // Broadcast: one notification from Wyre reaches every user's support chat.
    const broadcast = await rpc<{ sent: number }>(aliceCookie, 'mutation', 'wyre.adminBroadcastMessage', { text: 'Проверка рассылки Wyre' });
    assert.ok(broadcast.sent >= 2);
    const bobAfterBroadcast = await rpc<{ name: string; last: string }[]>(bobCookie, 'query', 'wyre.listChats');
    assert.equal(bobAfterBroadcast.find((chat) => chat.name === 'Wyre')?.last, 'Проверка рассылки Wyre');

    // Presence privacy is persisted server-side; per-chat recording states synchronize through MongoDB/realtime.
    await rpc(bobCookie, 'mutation', 'wyre.updatePresencePrivacy', {
      visibility: 'nobody', always: [], never: [],
    });
    let aliceChats = await rpc<{ id: string; status: string; presence: string }[]>(aliceCookie, 'query', 'wyre.listChats');
    assert.equal(aliceChats.find((chat) => chat.id === chatId)?.status, 'статус скрыт');
    await rpc(bobCookie, 'mutation', 'wyre.updatePresencePrivacy', {
      visibility: 'nobody', always: [peopleForBob[0].userId], never: [],
    });
    await rpc(bobCookie, 'mutation', 'wyre.setActivity', { chatId, activity: 'recording_voice' });
    aliceChats = await rpc(aliceCookie, 'query', 'wyre.listChats');
    assert.equal(aliceChats.find((chat) => chat.id === chatId)?.presence, 'recording_voice');
    await rpc(bobCookie, 'mutation', 'wyre.setActivity', { chatId, activity: null });

    const realtime = io(baseUrl, {
      extraHeaders: { Cookie: aliceCookie },
      rejectUnauthorized: false,
      transports: ['websocket'],
    });
    await new Promise<void>((resolve, reject) => {
      realtime.once('connect', resolve);
      realtime.once('connect_error', reject);
    });
    const changed = new Promise<void>((resolve) => realtime.once('wyre:changed', () => resolve()));
    await rpc(bobCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Привет, Алиса', kind: 'text' });
    await Promise.race([changed, delay(3000).then(() => { throw new Error('Realtime event was not received'); })]);
    realtime.close();

    let messages = await rpc<{ text: string; mine: boolean; status?: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId });
    assert.equal(messages.at(-1)?.text, 'Привет, Алиса');
    assert.equal(messages.at(-1)?.mine, false);
    await rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: JSON.stringify({ userId: peopleForAlice[0].userId, name: 'Подмена' }), kind: 'contact' });
    await rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: JSON.stringify({ latitude: 55.7558, longitude: 37.6173, accuracy: 12 }), kind: 'location' });
    const structuredMessages = await rpc<{ kind: string; text: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId });
    const contactPayload = JSON.parse(structuredMessages.find((message) => message.kind === 'contact')?.text ?? '{}');
    assert.equal(contactPayload.name, 'Боб');
    assert.equal(JSON.parse(structuredMessages.find((message) => message.kind === 'location')?.text ?? '{}').latitude, 55.7558);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: JSON.stringify({ latitude: 155, longitude: 37 }), kind: 'location' })).status, 400);
    const liveLocation = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: JSON.stringify({ latitude: 55.75, longitude: 37.61, accuracy: 20 }), kind: 'location', liveLocationMinutes: 15 });
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.updateLiveLocation', { messageId: liveLocation.messageId, latitude: 55.76, longitude: 37.62 })).status, 400);
    await rpc(aliceCookie, 'mutation', 'wyre.updateLiveLocation', { messageId: liveLocation.messageId, latitude: 55.76, longitude: 37.62, accuracy: 8 });
    const liveForBob = (await rpc<{ id: string; text: string; liveLocation?: { stopped: boolean } }[]>(bobCookie, 'query', 'wyre.listMessages', { chatId })).find((message) => message.id === liveLocation.messageId);
    assert.equal(JSON.parse(liveForBob?.text ?? '{}').latitude, 55.76);
    assert.equal(liveForBob?.liveLocation?.stopped, false);
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.stopLiveLocation', { messageId: liveLocation.messageId })).status, 400);
    await rpc(aliceCookie, 'mutation', 'wyre.stopLiveLocation', { messageId: liveLocation.messageId });
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.updateLiveLocation', { messageId: liveLocation.messageId, latitude: 55.77, longitude: 37.63 })).status, 400);
    const expiredLive = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: JSON.stringify({ latitude: 55.7, longitude: 37.6 }), kind: 'location', liveLocationMinutes: 15 });
    await mongoClient.db(dbName).collection('wyreMessages').updateOne({ _id: new ObjectId(expiredLive.messageId) }, { $set: { 'liveLocation.expiresAt': new Date(Date.now() - 1000) } });
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.updateLiveLocation', { messageId: expiredLive.messageId, latitude: 55.8, longitude: 37.7 })).status, 400);
    await rpc(aliceCookie, 'mutation', 'wyre.markChatRead', { chatId });
    const bobReceipts = await rpc<{ text: string; status?: string; statusAt?: string }[]>(bobCookie, 'query', 'wyre.listMessages', { chatId });
    const readReceipt = bobReceipts.find((message) => message.text === 'Привет, Алиса');
    assert.equal(readReceipt?.status, 'read');
    assert.ok(readReceipt?.statusAt && !Number.isNaN(Date.parse(readReceipt.statusAt)));
    // @username mentions are limited to chat members, synchronized and cleared when the chat is read.
    const candidates = await rpc<{ username: string }[]>(aliceCookie, 'query', 'wyre.mentionCandidates', { chatId });
    assert.deepEqual(candidates.map((candidate) => candidate.username), ['bob_wyre']);
    await rpc(bobCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Проверка для @alice_wyre', kind: 'text' });
    const mentionedChat = (await rpc<{ id: string; unreadMentions: number }[]>(aliceCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId);
    assert.equal(mentionedChat?.unreadMentions, 1);
    const mentionedMessages = await rpc<{ text: string; mentioned?: boolean }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId });
    assert.equal(mentionedMessages.at(-1)?.mentioned, true);
    await rpc(aliceCookie, 'mutation', 'wyre.markChatRead', { chatId });
    const readMentionChat = (await rpc<{ id: string; unreadMentions: number }[]>(aliceCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId);
    assert.equal(readMentionChat?.unreadMentions, 0);

    // Concurrent sends must not lose an unread increment (atomic $inc, no array rewrite).
    const unreadBefore = (await rpc<{ id: string; unread: number }[]>(bobCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId)?.unread ?? 0;
    await Promise.all([
      rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Параллельное 1', kind: 'text' }),
      rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Параллельное 2', kind: 'text' }),
      rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Параллельное 3', kind: 'text' }),
    ]);
    const unreadAfter = (await rpc<{ id: string; unread: number }[]>(bobCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId)?.unread ?? 0;
    assert.equal(unreadAfter - unreadBefore, 3);
    await rpc(bobCookie, 'mutation', 'wyre.markChatRead', { chatId });

    // Link previews are generated server-side with a safe domain fallback when remote metadata is unavailable.
    const linkMessage = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', {
      chatId, text: 'Полезная ссылка https://example.com/wyre', kind: 'text',
    });
    let linkRaw = await mongoClient.db(dbName).collection('wyreMessages').findOne({ _id: new ObjectId(linkMessage.messageId) });
    for (let attempt = 0; attempt < 12 && !linkRaw?.linkPreview; attempt += 1) {
      await delay(250);
      linkRaw = await mongoClient.db(dbName).collection('wyreMessages').findOne({ _id: new ObjectId(linkMessage.messageId) });
    }
    assert.equal(linkRaw?.kind, 'link');
    assert.equal(linkRaw?.linkPreview?.domain, 'example.com');
    let linkSerialized = await rpc<{ id: string; kind: string; link?: { title: string; domain: string } }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId });
    const serializedLink = linkSerialized.find((message) => message.id === linkMessage.messageId);
    if (!serializedLink?.link) {
      await delay(250);
      linkSerialized = await rpc<{ id: string; kind: string; link?: { title: string; domain: string } }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId });
    }
    assert.equal(linkSerialized.find((message) => message.id === linkMessage.messageId)?.link?.domain, 'example.com');
    const linkSafety = await rpc<{ level: string; reason: string }>(bobCookie, 'mutation', 'wyre.checkLinkSafety', { messageId: linkMessage.messageId });
    assert.equal(linkSafety.level, 'low');
    assert.match(linkSafety.reason, /признаков подмены/);
    assert.equal((await rpc<{ level: string }>(aliceCookie, 'mutation', 'wyre.checkLinkSafety', { messageId: linkMessage.messageId })).level, 'low');
    assert.equal(phishingRequests, 1);
    assert.equal((await rpcError(charlieCookie, 'mutation', 'wyre.checkLinkSafety', { messageId: linkMessage.messageId })).status, 400);
    const checkedLink = (await rpc<{ id: string; linkSafety?: { level: string } }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId })).find((message) => message.id === linkMessage.messageId);
    assert.equal(checkedLink?.linkSafety?.level, 'low');

    // Self-destruct starts only after a recipient reads the message and is hidden/removed afterwards.
    const selfDestruct = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', {
      chatId, text: 'Исчезающее сообщение', kind: 'text', selfDestructSeconds: 5,
    });
    let selfRaw = await mongoClient.db(dbName).collection('wyreMessages').findOne({ _id: new ObjectId(selfDestruct.messageId) });
    assert.equal(selfRaw?.deleteAt ?? null, null);
    await rpc(bobCookie, 'mutation', 'wyre.markChatRead', { chatId });
    selfRaw = await mongoClient.db(dbName).collection('wyreMessages').findOne({ _id: new ObjectId(selfDestruct.messageId) });
    assert.ok(selfRaw?.deleteAt instanceof Date);
    await delay(6500);
    const afterSelfDestruct = await rpc<{ id: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId });
    assert.equal(afterSelfDestruct.some((message) => message.id === selfDestruct.messageId), false);

    // Chat auto-delete is persisted and validated server-side; it applies to subsequently sent messages.
    const autoDeleteChat = await rpc<{ autoDeleteAfterDays: number | null }>(aliceCookie, 'mutation', 'wyre.setChatAutoDelete', { chatId, days: 1 });
    assert.equal(autoDeleteChat.autoDeleteAfterDays, 1);
    const autoDeleteMessage = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', {
      chatId, text: 'Сообщение с автоудалением', kind: 'text',
    });
    const autoRaw = await mongoClient.db(dbName).collection('wyreMessages').findOne({ _id: new ObjectId(autoDeleteMessage.messageId) });
    assert.ok(autoRaw?.deleteAt instanceof Date);
    assert.ok((autoRaw?.deleteAt as Date).getTime() > Date.now() + 23 * 60 * 60 * 1000);
    await rpc(aliceCookie, 'mutation', 'wyre.setChatAutoDelete', { chatId, days: null });

    // Signed private attachment upload and authenticated download.
    const ticket = await rpc<{ url: string; fields: Record<string, string>; filePath: string }>(
      aliceCookie,
      'mutation',
      'wyre.requestAttachmentUpload',
      { chatId, fileName: 'note.txt', fileSize: 10, contentType: 'text/plain' },
    );
    const form = new FormData();
    for (const [key, value] of Object.entries(ticket.fields)) form.append(key, value);
    form.append('file', new Blob(['hello wyre'], { type: 'text/plain' }), 'note.txt');
    const uploaded = await fetch(`${baseUrl}${ticket.url}`, { method: 'POST', headers: { Cookie: aliceCookie }, body: form });
    assert.equal(uploaded.status, 201);
    const folderTransferMessage = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', {
      chatId,
      text: '',
      kind: 'file',
      filePath: ticket.filePath,
      mimeType: 'text/plain',
      fileName: 'note.txt',
      fileSize: '10 Б',
      requestFolderTransfer: true,
    });
    const withFile = await rpc<{ id: string; fileUrl?: string; bookmarked?: boolean; folderTransfer?: { status: string; canRespond: boolean } }[]>(bobCookie, 'query', 'wyre.listMessages', { chatId });
    const fileUrl = withFile.at(-1)?.fileUrl;
    assert.ok(fileUrl);
    assert.equal(withFile.at(-1)?.folderTransfer?.status, 'pending');
    assert.equal(withFile.at(-1)?.folderTransfer?.canRespond, true);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.respondFolderTransfer', { messageId: folderTransferMessage.messageId, status: 'accepted' })).status, 400);
    assert.equal((await rpc<{ status: string }>(bobCookie, 'mutation', 'wyre.respondFolderTransfer', { messageId: folderTransferMessage.messageId, status: 'accepted' })).status, 'accepted');
    assert.equal((await rpc<{ status: string }>(bobCookie, 'mutation', 'wyre.respondFolderTransfer', { messageId: folderTransferMessage.messageId, status: 'completed' })).status, 'completed');
    const completedTransfer = (await rpc<{ id: string; folderTransfer?: { status: string; canRespond: boolean } }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId })).find((message) => message.id === folderTransferMessage.messageId);
    assert.equal(completedTransfer?.folderTransfer?.status, 'completed');
    assert.equal(completedTransfer?.folderTransfer?.canRespond, false);
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.respondFolderTransfer', { messageId: folderTransferMessage.messageId, status: 'accepted' })).status, 400);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'not a file', kind: 'text', requestFolderTransfer: true })).status, 400);
    const downloaded = await fetch(`${baseUrl}${fileUrl}`, { headers: { Cookie: bobCookie } });
    assert.equal(await downloaded.text(), 'hello wyre');
    const bookmarkedMessageId = withFile.at(-1)?.id;
    assert.ok(bookmarkedMessageId);
    await rpc(aliceCookie, 'mutation', 'wyre.toggleMessageBookmark', { messageId: bookmarkedMessageId });
    const aliceBookmarked = await rpc<{ id: string; bookmarked?: boolean }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId });
    assert.equal(aliceBookmarked.find((message) => message.id === bookmarkedMessageId)?.bookmarked, true);

    const htmlTicket = await rpc<{ url: string; fields: Record<string, string>; filePath: string }>(
      aliceCookie,
      'mutation',
      'wyre.requestAttachmentUpload',
      { chatId, fileName: 'preview.html', fileSize: 45, contentType: 'text/html' },
    );
    const htmlForm = new FormData();
    for (const [key, value] of Object.entries(htmlTicket.fields)) htmlForm.append(key, value);
    htmlForm.append('file', new Blob(['<h1>Wyre</h1><script>throw new Error()</script>'], { type: 'text/html' }), 'preview.html');
    assert.equal((await fetch(`${baseUrl}${htmlTicket.url}`, { method: 'POST', headers: { Cookie: aliceCookie }, body: htmlForm })).status, 201);
    await rpc(aliceCookie, 'mutation', 'wyre.sendMessage', {
      chatId, text: '', kind: 'file', filePath: htmlTicket.filePath, mimeType: 'text/html', fileName: 'preview.html', fileSize: '45 Б',
    });
    const htmlMessages = await rpc<{ kind: string; fileUrl?: string }[]>(bobCookie, 'query', 'wyre.listMessages', { chatId });
    assert.equal(htmlMessages.at(-1)?.kind, 'html');
    assert.ok(htmlMessages.at(-1)?.fileUrl);

    // Stories are real MongoDB data: visible to contacts, synchronized and removed from the unseen list after viewing.
    const storyTicket = await rpc<{ url: string; fields: Record<string, string>; filePath: string }>(
      aliceCookie,
      'mutation',
      'wyre.requestStoryUpload',
      { fileName: 'story.png', fileSize: 8, contentType: 'image/png' },
    );
    const storyForm = new FormData();
    for (const [key, value] of Object.entries(storyTicket.fields)) storyForm.append(key, value);
    storyForm.append('file', new Blob(['png-data'], { type: 'image/png' }), 'story.png');
    const storyUploaded = await fetch(`${baseUrl}${storyTicket.url}`, {
      method: 'POST', headers: { Cookie: aliceCookie }, body: storyForm,
    });
    assert.equal(storyUploaded.status, 201);
    await rpc(aliceCookie, 'mutation', 'wyre.createStory', {
      caption: 'История из интеграционного теста',
      filePath: storyTicket.filePath,
      mimeType: 'image/png',
    });
    const unseenStories = await rpc<{ id: string; caption: string; mediaUrl: string }[]>(bobCookie, 'query', 'wyre.listStories');
    assert.equal(unseenStories.length, 1);
    assert.equal(unseenStories[0].caption, 'История из интеграционного теста');
    const storyMedia = await fetch(`${baseUrl}${unseenStories[0].mediaUrl}`, { headers: { Cookie: bobCookie } });
    assert.equal(await storyMedia.text(), 'png-data');
    await rpc(bobCookie, 'mutation', 'wyre.markStoryViewed', { storyId: unseenStories[0].id });
    assert.equal((await rpc<unknown[]>(bobCookie, 'query', 'wyre.listStories')).length, 0);
    assert.equal(await mongoClient.db(dbName).collection('wyreStoryViews').countDocuments(), 1);

    // More than one group verifies the partial unique direct-chat index.
    const groupOne = await rpc<{ chatId: string }>(aliceCookie, 'mutation', 'wyre.createGroup', {
      title: 'Семья', memberIds: [peopleForAlice[0].userId],
    });
    const groupTwo = await rpc<{ chatId: string }>(aliceCookie, 'mutation', 'wyre.createGroup', {
      title: 'Друзья', memberIds: [peopleForAlice[0].userId],
    });
    assert.notEqual(groupOne.chatId, groupTwo.chatId);
    const groupDetails = await rpc<{ myRole: string; members: { username: string; role: string }[] }>(aliceCookie, 'query', 'wyre.groupDetails', { chatId: groupOne.chatId });
    assert.equal(groupDetails.myRole, 'owner');
    assert.equal(groupDetails.members.find((member) => member.username === 'bob_wyre')?.role, 'member');
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.createTopic', { chatId: groupOne.chatId, title: 'Без прав' })).status, 400);
    await rpc(aliceCookie, 'mutation', 'wyre.setGroupMemberRole', { chatId: groupOne.chatId, userId: peopleForAlice[0].userId, role: 'admin' });
    await rpc(bobCookie, 'mutation', 'wyre.updateGroup', { chatId: groupOne.chatId, title: 'Семья и друзья', description: 'Общий чат' });
    const updatedGroup = await rpc<{ title: string; description: string; myRole: string }>(bobCookie, 'query', 'wyre.groupDetails', { chatId: groupOne.chatId });
    assert.equal(updatedGroup.title, 'Семья и друзья');
    assert.equal(updatedGroup.description, 'Общий чат');
    assert.equal(updatedGroup.myRole, 'admin');

    // Group photo: only owners/admins may set it, and members see the same URL.
    const groupAvatarTicket = await rpc<{ url: string; fields: Record<string, string>; filePath: string }>(aliceCookie, 'mutation', 'wyre.requestGroupAvatarUpload', {
      chatId: groupOne.chatId, fileName: 'group.png', fileSize: 8, contentType: 'image/png',
    });
    const groupAvatarForm = new FormData();
    for (const [key, value] of Object.entries(groupAvatarTicket.fields)) groupAvatarForm.append(key, value);
    groupAvatarForm.append('file', new Blob(['png-data'], { type: 'image/png' }), 'group.png');
    assert.equal((await fetch(`${baseUrl}${groupAvatarTicket.url}`, { method: 'POST', headers: { Cookie: aliceCookie }, body: groupAvatarForm })).status, 201);
    await rpc(aliceCookie, 'mutation', 'wyre.setGroupAvatar', { chatId: groupOne.chatId, filePath: groupAvatarTicket.filePath, mimeType: 'image/png' });
    assert.ok((await rpc<{ id: string; avatarUrl?: string }[]>(bobCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === groupOne.chatId)?.avatarUrl);
    assert.equal((await rpcError(charlieCookie, 'mutation', 'wyre.requestGroupAvatarUpload', { chatId: groupOne.chatId, fileName: 'x.png', fileSize: 8, contentType: 'image/png' })).status, 400);

    const createdTopic = await rpc<{ topicId: string }>(aliceCookie, 'mutation', 'wyre.createTopic', { chatId: groupOne.chatId, title: 'Планы' });
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.createTopic', { chatId: groupOne.chatId, title: 'планы' })).status, 400);
    await rpc(bobCookie, 'mutation', 'wyre.renameTopic', { topicId: createdTopic.topicId, title: 'Планы семьи' });
    assert.equal((await rpcError(charlieCookie, 'query', 'wyre.listTopics', { chatId: groupOne.chatId })).status, 400);
    const topicMessage = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', {
      chatId: groupOne.chatId, topicId: createdTopic.topicId, text: 'Собираемся в субботу', kind: 'text',
    });
    const scopedTopicMessages = await rpc<{ id: string; topicId?: string; text: string }[]>(bobCookie, 'query', 'wyre.listMessages', { chatId: groupOne.chatId, topicId: createdTopic.topicId });
    assert.deepEqual(scopedTopicMessages.map((message) => message.id), [topicMessage.messageId]);
    assert.equal(scopedTopicMessages[0]?.topicId, createdTopic.topicId);
    let topicList = await rpc<{ id: string; title: string; unread: number; closed: boolean; last: string }[]>(bobCookie, 'query', 'wyre.listTopics', { chatId: groupOne.chatId });
    assert.equal(topicList[0]?.title, 'Планы семьи');
    assert.equal(topicList[0]?.unread, 1);
    assert.equal(topicList[0]?.last, 'Собираемся в субботу');
    await rpc(bobCookie, 'mutation', 'wyre.markChatRead', { chatId: groupOne.chatId, topicId: createdTopic.topicId });
    topicList = await rpc<{ id: string; title: string; unread: number; closed: boolean; last: string }[]>(bobCookie, 'query', 'wyre.listTopics', { chatId: groupOne.chatId });
    assert.equal(topicList[0]?.unread, 0);
    await rpc(bobCookie, 'mutation', 'wyre.setTopicClosed', { topicId: createdTopic.topicId, closed: true });
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId: groupOne.chatId, topicId: createdTopic.topicId, text: 'Закрытая тема', kind: 'text' })).status, 400);
    await rpc(aliceCookie, 'mutation', 'wyre.setTopicClosed', { topicId: createdTopic.topicId, closed: false });
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, topicId: createdTopic.topicId, text: 'Чужой чат', kind: 'text' })).status, 400);
    const albumTicket = await rpc<{ url: string; fields: Record<string, string>; filePath: string }>(aliceCookie, 'mutation', 'wyre.requestAttachmentUpload', {
      chatId: groupOne.chatId, fileName: 'family.png', fileSize: 8, contentType: 'image/png',
    });
    const albumForm = new FormData();
    for (const [key, value] of Object.entries(albumTicket.fields)) albumForm.append(key, value);
    albumForm.append('file', new Blob(['png-data'], { type: 'image/png' }), 'family.png');
    assert.equal((await fetch(`${baseUrl}${albumTicket.url}`, { method: 'POST', headers: { Cookie: aliceCookie }, body: albumForm })).status, 201);
    await rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId: groupOne.chatId, text: 'Семейное фото', kind: 'file', filePath: albumTicket.filePath, mimeType: 'image/png', fileName: 'family.png', fileSize: '8 Б' });
    const groupAlbum = await rpc<{ fileName: string; caption: string; url: string }[]>(bobCookie, 'query', 'wyre.groupMediaAlbum', { chatId: groupOne.chatId });
    assert.equal(groupAlbum[0]?.fileName, 'family.png');
    assert.equal(groupAlbum[0]?.caption, 'Семейное фото');
    assert.ok(groupAlbum[0]?.url);
    assert.equal((await rpcError(charlieCookie, 'query', 'wyre.groupMediaAlbum', { chatId: groupOne.chatId })).status, 400);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.createPoll', {
      chatId, question: 'Опрос в личке', options: ['Да', 'Нет'], quiz: false,
    })).status, 400);
    const pollCreated = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.createPoll', {
      chatId: groupOne.chatId,
      topicId: createdTopic.topicId,
      question: 'Куда поедем?',
      options: ['На море', 'В горы', 'На дачу'],
      quiz: false,
    });
    type PollView = {
      id: string;
      poll?: {
        options: { id: string; votes: number; selected: boolean }[];
        totalVotes: number;
        correctOptionId?: string;
        closed: boolean;
      };
    };
    let poll = (await rpc<PollView[]>(bobCookie, 'query', 'wyre.listMessages', { chatId: groupOne.chatId })).find((message) => message.id === pollCreated.messageId);
    assert.ok(poll?.poll);
    await rpc(bobCookie, 'mutation', 'wyre.votePoll', { messageId: pollCreated.messageId, optionId: poll.poll.options[0].id });
    await rpc(bobCookie, 'mutation', 'wyre.votePoll', { messageId: pollCreated.messageId, optionId: poll.poll.options[1].id });
    poll = (await rpc<PollView[]>(bobCookie, 'query', 'wyre.listMessages', { chatId: groupOne.chatId })).find((message) => message.id === pollCreated.messageId);
    assert.equal(poll?.poll?.totalVotes, 1);
    assert.equal(poll?.poll?.options.filter((option) => option.selected).length, 1);
    assert.equal(poll?.poll?.options[1].selected, true);
    const alicePoll = (await rpc<PollView[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId: groupOne.chatId })).find((message) => message.id === pollCreated.messageId);
    await rpc(aliceCookie, 'mutation', 'wyre.votePoll', { messageId: pollCreated.messageId, optionId: alicePoll!.poll!.options[0].id });
    assert.equal((await rpc<PollView[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId: groupOne.chatId })).find((message) => message.id === pollCreated.messageId)?.poll?.totalVotes, 2);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.votePoll', { messageId: pollCreated.messageId, optionId: new ObjectId().toString() })).status, 400);

    const quizCreated = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.createPoll', {
      chatId: groupOne.chatId,
      question: 'Сколько будет 2 + 2?',
      options: ['3', '4', '5'],
      quiz: true,
      correctOptionIndex: 1,
    });
    let quiz = (await rpc<PollView[]>(bobCookie, 'query', 'wyre.listMessages', { chatId: groupOne.chatId })).find((message) => message.id === quizCreated.messageId);
    assert.equal(quiz?.poll?.correctOptionId, undefined);
    await rpc(bobCookie, 'mutation', 'wyre.votePoll', { messageId: quizCreated.messageId, optionId: quiz!.poll!.options[0].id });
    quiz = (await rpc<PollView[]>(bobCookie, 'query', 'wyre.listMessages', { chatId: groupOne.chatId })).find((message) => message.id === quizCreated.messageId);
    assert.equal(quiz?.poll?.correctOptionId, quiz?.poll?.options[1].id);
    await rpc(bobCookie, 'mutation', 'wyre.closePoll', { messageId: quizCreated.messageId });
    assert.equal((await rpc<PollView[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId: groupOne.chatId })).find((message) => message.id === quizCreated.messageId)?.poll?.closed, true);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.votePoll', { messageId: quizCreated.messageId, optionId: quiz!.poll!.options[1].id })).status, 400);
    await rpc(aliceCookie, 'mutation', 'wyre.forwardMessage', { messageId: bookmarkedMessageId, targetChatId: groupOne.chatId });
    const forwarded = await rpc<{ forwardedFromName?: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId: groupOne.chatId });
    assert.equal(forwarded.at(-1)?.forwardedFromName, 'Алиса');

    await rpc(bobCookie, 'mutation', 'wyre.deleteChat', { chatId: groupTwo.chatId });
    assert.equal((await rpcError(bobCookie, 'query', 'wyre.groupDetails', { chatId: groupTwo.chatId })).status, 400);
    assert.equal((await rpc<{ members: unknown[] }>(aliceCookie, 'query', 'wyre.groupDetails', { chatId: groupTwo.chatId })).members.length, 1);
    await rpc(aliceCookie, 'mutation', 'wyre.deleteChat', { chatId: groupTwo.chatId });
    assert.equal((await rpcError(aliceCookie, 'query', 'wyre.groupDetails', { chatId: groupTwo.chatId })).status, 400);
    assert.equal(await mongoClient.db(dbName).collection('wyreChats').countDocuments({ _id: new ObjectId(groupTwo.chatId) }), 0);

    await rpc(bobCookie, 'mutation', 'wyre.leaveGroup', { chatId: groupOne.chatId });
    const afterLeave = await rpc<{ members: unknown[] }>(aliceCookie, 'query', 'wyre.groupDetails', { chatId: groupOne.chatId });
    assert.equal(afterLeave.members.length, 1);
    await rpc(aliceCookie, 'mutation', 'wyre.addGroupMembers', { chatId: groupOne.chatId, userIds: [peopleForAlice[0].userId] });

    const inviteCall = await rpc<{ callId: string }>(aliceCookie, 'mutation', 'wyre.startCall', { chatId: groupOne.chatId, kind: 'video' });
    const expiredInvite = await rpc<{ url: string }>(aliceCookie, 'mutation', 'wyre.createCallInvite', { callId: inviteCall.callId });
    assert.match(expiredInvite.url, /^https:\/\//);
    const expiredToken = new URL(expiredInvite.url).searchParams.get('callInvite');
    assert.ok(expiredToken);
    await mongoClient.db(dbName).collection('wyreCallInvites').updateOne({ callId: inviteCall.callId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await rpcError(charlieCookie, 'mutation', 'wyre.joinCallInvite', { token: expiredToken })).status, 400);
    const activeInvite = await rpc<{ url: string }>(aliceCookie, 'mutation', 'wyre.createCallInvite', { callId: inviteCall.callId });
    const activeToken = new URL(activeInvite.url).searchParams.get('callInvite');
    assert.ok(activeToken);
    assert.equal((await rpc<{ callId: string }>(charlieCookie, 'mutation', 'wyre.joinCallInvite', { token: activeToken })).callId, inviteCall.callId);
    const invitedState = await rpc<{ callId: string; group: boolean; myState: string }>(charlieCookie, 'query', 'wyre.callState');
    assert.equal(invitedState.callId, inviteCall.callId);
    assert.equal(invitedState.group, true);
    assert.equal(invitedState.myState, 'invited');
    await rpc(charlieCookie, 'mutation', 'wyre.acceptCall', { callId: inviteCall.callId });
    // Repeated concurrent accepts must be idempotent and must not drop anyone.
    await Promise.all([
      rpc(charlieCookie, 'mutation', 'wyre.acceptCall', { callId: inviteCall.callId }),
      rpc(charlieCookie, 'mutation', 'wyre.acceptCall', { callId: inviteCall.callId }),
    ]);
    const joinedState = await rpc<{ participants: { userId: string; state: string }[] }>(aliceCookie, 'query', 'wyre.callState');
    assert.equal(joinedState.participants.filter((participant) => participant.state === 'joined').length, 2);
    const aliceControlState = await rpc<{ remoteControlCode: string }>(aliceCookie, 'query', 'wyre.callState');
    const charlieControlState = await rpc<{ remoteControlCode: string }>(charlieCookie, 'query', 'wyre.callState');
    assert.match(aliceControlState.remoteControlCode, /^\d{8}$/);
    assert.match(charlieControlState.remoteControlCode, /^\d{8}$/);
    assert.notEqual(aliceControlState.remoteControlCode, charlieControlState.remoteControlCode);
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.requestRemoteControl', { callId: inviteCall.callId, code: charlieControlState.remoteControlCode })).status, 400);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.requestRemoteControl', { callId: inviteCall.callId, code: '00000000' })).status, 400);
    await rpc(aliceCookie, 'mutation', 'wyre.requestRemoteControl', { callId: inviteCall.callId, code: charlieControlState.remoteControlCode });
    const pendingControl = await rpc<{ remoteControl: { status: string; isTarget: boolean; controllerName: string } }>(charlieCookie, 'query', 'wyre.callState');
    assert.equal(pendingControl.remoteControl.status, 'pending');
    assert.equal(pendingControl.remoteControl.isTarget, true);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.respondRemoteControl', { callId: inviteCall.callId, accept: true })).status, 400);
    await rpc(charlieCookie, 'mutation', 'wyre.respondRemoteControl', { callId: inviteCall.callId, accept: true });
    assert.equal((await rpcError(charlieCookie, 'mutation', 'wyre.sendRemoteControlEvent', { callId: inviteCall.callId, type: 'pointer_move', x: 0.2, y: 0.3, button: 0 })).status, 400);
    await rpc(aliceCookie, 'mutation', 'wyre.sendRemoteControlEvent', { callId: inviteCall.callId, type: 'pointer_move', x: 0.2, y: 0.3, button: 0 });
    const controlEvents = await rpc<{ type: string; x: number; y: number }[]>(charlieCookie, 'query', 'wyre.remoteControlEvents', { callId: inviteCall.callId });
    assert.equal(controlEvents.at(-1)?.type, 'pointer_move');
    assert.equal(controlEvents.at(-1)?.x, 0.2);
    assert.equal((await rpcError(bobCookie, 'query', 'wyre.remoteControlEvents', { callId: inviteCall.callId })).status, 400);
    await rpc(charlieCookie, 'mutation', 'wyre.stopRemoteControl', { callId: inviteCall.callId });
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.sendRemoteControlEvent', { callId: inviteCall.callId, type: 'pointer_down', x: 0.2, y: 0.3, button: 0 })).status, 400);
    await rpc(charlieCookie, 'mutation', 'wyre.requestRemoteControl', { callId: inviteCall.callId, code: aliceControlState.remoteControlCode });
    await rpc(aliceCookie, 'mutation', 'wyre.respondRemoteControl', { callId: inviteCall.callId, accept: false });
    assert.equal((await rpc<{ remoteControl: { status: string } }>(charlieCookie, 'query', 'wyre.callState')).remoteControl.status, 'declined');
    await rpc(charlieCookie, 'mutation', 'wyre.leaveCall', { callId: inviteCall.callId });
    await rpc(aliceCookie, 'mutation', 'wyre.leaveCall', { callId: inviteCall.callId });
    assert.equal((await rpcError(charlieCookie, 'mutation', 'wyre.joinCallInvite', { token: activeToken })).status, 400);

    const channel = await rpc<{ channelId: string }>(aliceCookie, 'mutation', 'wyre.createChannel', { title: 'Новости Wyre', description: 'Тестовый канал' });
    const discovered = await rpc<{ id: string; subscribed: boolean }[]>(bobCookie, 'query', 'wyre.discoverChannels', { query: 'Новости' });
    assert.equal(discovered[0]?.id, channel.channelId);
    assert.equal(discovered[0]?.subscribed, false);
    await rpc(bobCookie, 'mutation', 'wyre.joinChannel', { channelId: channel.channelId });
    const post = await rpc<{ postId: string }>(aliceCookie, 'mutation', 'wyre.publishPost', { channelId: channel.channelId, text: 'Первый пост' });
    await rpc(bobCookie, 'mutation', 'wyre.viewChannelPost', { postId: post.postId });
    await rpc(bobCookie, 'mutation', 'wyre.reactChannelPost', { postId: post.postId, emoji: '👍' });
    await rpc(bobCookie, 'mutation', 'wyre.commentChannelPost', { postId: post.postId, text: 'Комментарий' });
    const feed = await rpc<{ views: number; comments: number; reactions: { emoji: string; count: number }[] }[]>(bobCookie, 'query', 'wyre.channelFeed', { channelId: channel.channelId });
    assert.equal(feed[0]?.views, 2);
    assert.equal(feed[0]?.comments, 1);
    assert.equal(feed[0]?.reactions[0]?.count, 1);
    assert.equal((await rpc<{ text: string }[]>(bobCookie, 'query', 'wyre.postComments', { postId: post.postId }))[0]?.text, 'Комментарий');

    // User-ID blocks are directional records with bidirectional enforcement. Existing direct history remains readable,
    // while discovery, new direct actions, direct messages, calls, stories and owner-channel comments are denied.
    await rpc(aliceCookie, 'mutation', 'wyre.blockUser', { userId: peopleForAlice[0].userId });
    assert.equal((await rpc<{ userId: string }[]>(aliceCookie, 'query', 'wyre.blockedUsers')).length, 1);
    assert.equal((await rpc<unknown[]>(aliceCookie, 'query', 'wyre.searchPeople', { query: 'bob' })).length, 0);
    assert.equal((await rpc<unknown[]>(bobCookie, 'query', 'wyre.searchPeople', { query: 'alice' })).length, 0);
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.openDirectChat', { peerId: peopleForBob[0].userId })).body.error?.code, 'USER_BLOCKED');
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Не пройдёт', kind: 'text' })).body.error?.code, 'USER_BLOCKED');
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.startCall', { chatId, kind: 'audio' })).body.error?.code, 'USER_BLOCKED');
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.commentChannelPost', { postId: post.postId, text: 'Не пройдёт' })).body.error?.code, 'USER_BLOCKED');
    const historical = await rpc<{ text: string }[]>(bobCookie, 'query', 'wyre.listMessages', { chatId });
    assert.ok(historical.length > 0);
    await rpc(aliceCookie, 'mutation', 'wyre.unblockUser', { userId: peopleForAlice[0].userId });
    assert.equal((await rpc<{ userId: string }[]>(aliceCookie, 'query', 'wyre.blockedUsers')).length, 0);
    await rpc(bobCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'После разблокировки', kind: 'text' });
    await rpc(aliceCookie, 'mutation', 'wyre.updateSettings', { themeId: 7, fontSize: 18, font: 'rounded', autoTheme: true, dnd: true, dndFrom: '22:30', dndTo: '07:15', previews: false });
    await rpc(aliceCookie, 'mutation', 'wyre.toggleMuteChat', { chatId });
    const dbgChat = await mongoClient.db(dbName).collection('wyreChats').findOne({ _id: new ObjectId(chatId) });
    console.info('DEBUG members after toggle:', JSON.stringify(dbgChat?.members));
    assert.equal((await rpc<{ id: string; muted: boolean }[]>(aliceCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId)?.muted, true);
    assert.equal((await rpc<{ id: string; muted: boolean }[]>(bobCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId)?.muted, false);
    const muteUntil = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await rpc(aliceCookie, 'mutation', 'wyre.updateChatNotifications', { chatId, mode: 'mentions', mutedUntil: muteUntil });
    const notificationChat = (await rpc<{ id: string; muted: boolean; notificationMode: string; mutedUntil: string | null }[]>(aliceCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId);
    assert.equal(notificationChat?.notificationMode, 'mentions');
    assert.equal(notificationChat?.muted, true);
    assert.ok(notificationChat?.mutedUntil);
    assert.equal((await rpc<{ id: string; notificationMode: string }[]>(bobCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId)?.notificationMode, 'all');
    await rpc(aliceCookie, 'mutation', 'wyre.updateChatNotifications', { chatId, mode: 'all', mutedUntil: null });
    assert.equal((await rpc<{ id: string; muted: boolean }[]>(aliceCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId)?.muted, false);
    await rpc(aliceCookie, 'mutation', 'wyre.setChatFolders', { chatId, folders: ['work'] });
    assert.deepEqual((await rpc<{ id: string; folders: string[] }[]>(aliceCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId)?.folders, ['all', 'work']);
    assert.deepEqual((await rpc<{ id: string; folders: string[] }[]>(bobCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId)?.folders, ['all']);
    await rpc(aliceCookie, 'mutation', 'wyre.setChatFolders', { chatId, folders: ['work', 'family'] });
    assert.deepEqual((await rpc<{ id: string; folders: string[] }[]>(aliceCookie, 'query', 'wyre.listChats')).find((chat) => chat.id === chatId)?.folders, ['all', 'work', 'family']);
    const forbiddenSettings = await rpcError('', 'mutation', 'wyre.updateSettings', { themeId: 2 });
    assert.equal(forbiddenSettings.status, 401);
    const persistedSettings = await rpc<{ themeId: number; fontSize: number; font: string; autoTheme: boolean; dnd: boolean }>(aliceCookie, 'query', 'wyre.settings');
    assert.equal(persistedSettings.themeId, 7);
    assert.equal(persistedSettings.fontSize, 18);
    assert.equal(persistedSettings.font, 'rounded');
    assert.equal(persistedSettings.dnd, true);

    // Granular privacy rules are enforced on the server and their explicit
    // per-user exceptions override the general rule.
    await rpc(bobCookie, 'mutation', 'wyre.setPhone', { phone: '+7 900 111-22-33' });
    await rpc(bobCookie, 'mutation', 'wyre.updateSettings', {
      findByPhone: 'nobody', callPermission: 'nobody', invitePermission: 'nobody', phoneVisibility: 'nobody', contentFilter: 'none',
    });
    assert.equal((await rpc<unknown[]>(aliceCookie, 'query', 'wyre.searchPeople', { query: '+7 900 111-22-33' })).length, 0);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.startCall', { chatId, kind: 'audio' })).body.error?.code, 'PRIVACY_RESTRICTED');
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.createGroup', { title: 'Privacy denied', memberIds: [peopleForAlice[0].userId] })).body.error?.code, 'PRIVACY_RESTRICTED');
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Скрытый контент', kind: 'text' })).body.error?.code, 'CONTENT_RESTRICTED');
    await rpc(bobCookie, 'mutation', 'wyre.updateSettings', {
      privacyAlways: {
        find: [peopleForBob[0].userId], call: [peopleForBob[0].userId], invite: [peopleForBob[0].userId], phone: [peopleForBob[0].userId],
      },
      contentFilter: 'all',
    });
    const foundByPhone = await rpc<{ userId: string; phone: string | null }[]>(aliceCookie, 'query', 'wyre.searchPeople', { query: '+7 900 111-22-33' });
    assert.equal(foundByPhone[0]?.userId, peopleForAlice[0].userId);
    assert.equal(foundByPhone[0]?.phone, '79001112233');
    const privacyGroup = await rpc<{ chatId: string }>(aliceCookie, 'mutation', 'wyre.createGroup', { title: 'Privacy allowed', memberIds: [peopleForAlice[0].userId] });
    assert.ok(privacyGroup.chatId);
    const privacyCall = await rpc<{ callId: string }>(aliceCookie, 'mutation', 'wyre.startCall', { chatId, kind: 'audio' });
    await rpc(aliceCookie, 'mutation', 'wyre.leaveCall', { callId: privacyCall.callId });
    await rpc(bobCookie, 'mutation', 'wyre.updateSettings', {
      findByPhone: 'contacts', callPermission: 'contacts', invitePermission: 'all', phoneVisibility: 'contacts', contentFilter: 'all', privacyAlways: {}, privacyNever: {},
    });

    // Family protection requires a one-use code accepted from the child
    // account. Guardians can enforce safety policy, never read chat content.
    const familyInvite = await rpc<{ code: string }>(aliceCookie, 'mutation', 'wyre.createFamilyInvite');
    assert.match(familyInvite.code, /^[A-Z2-9]{8}$/);
    await rpc(bobCookie, 'mutation', 'wyre.acceptFamilyInvite', { code: familyInvite.code });
    const guardianFamily = await rpc<{ children: { userId: string }[] }>(aliceCookie, 'query', 'wyre.familyStatus');
    const childFamily = await rpc<{ managed: boolean; guardians: { userId: string }[] }>(bobCookie, 'query', 'wyre.familyStatus');
    assert.equal(guardianFamily.children[0]?.userId, peopleForAlice[0].userId);
    assert.equal(childFamily.managed, true);
    assert.equal(childFamily.guardians[0]?.userId, peopleForBob[0].userId);
    await rpc(aliceCookie, 'mutation', 'wyre.setChildProtection', {
      childId: peopleForAlice[0].userId,
      enabled: true,
      callPermission: 'nobody',
      invitePermission: 'nobody',
      findByPhone: 'nobody',
      phoneVisibility: 'nobody',
      contentFilter: 'none',
    });
    await rpc(bobCookie, 'mutation', 'wyre.updateSettings', {
      familyProtection: false, safeMode: false, callPermission: 'all', invitePermission: 'all', contentFilter: 'all',
    });
    const managedSettings = await rpc<{ familyProtection: boolean; safeMode: boolean; callPermission: string; contentFilter: string }>(bobCookie, 'query', 'wyre.settings');
    assert.equal(managedSettings.familyProtection, true);
    assert.equal(managedSettings.safeMode, true);
    assert.equal(managedSettings.callPermission, 'nobody');
    assert.equal(managedSettings.contentFilter, 'none');
    await rpc(bobCookie, 'mutation', 'wyre.removeFamilyLink', { userId: peopleForBob[0].userId });
    assert.equal((await rpc<{ managed: boolean }>(bobCookie, 'query', 'wyre.familyStatus')).managed, false);
    await rpc(bobCookie, 'mutation', 'wyre.updateSettings', {
      safeMode: false, familyProtection: false, findByPhone: 'contacts', callPermission: 'contacts', invitePermission: 'all', phoneVisibility: 'contacts', contentFilter: 'all',
    });

    const beforeRevoke = await rpc<{ id: string; current: boolean }[]>(aliceCookie, 'query', 'wyre.activeSessions');
    assert.ok(beforeRevoke.some((session) => !session.current));
    const revokeResult = await rpc<{ revoked: number }>(aliceCookie, 'mutation', 'wyre.revokeOtherSessions');
    assert.ok(revokeResult.revoked >= 1);
    assert.deepEqual((await rpc<{ current: boolean }[]>(aliceCookie, 'query', 'wyre.activeSessions')).map((session) => session.current), [true]);
    const totpSetup = await rpc<{ uri: string }>(aliceCookie, 'mutation', 'wyre.beginTotp');
    const totpSecret = new URL(totpSetup.uri).searchParams.get('secret');
    assert.ok(totpSecret);
    const totpCode = await generateTotp({ secret: totpSecret });
    await rpc(aliceCookie, 'mutation', 'wyre.confirmTotp', { code: totpCode });
    assert.equal((await rpc<{ enabled: boolean }>(aliceCookie, 'query', 'wyre.totpStatus')).enabled, true);

    // Enabling TOTP verifies the current session, but every new login remains
    // gated after the existing username/phone challenge until TOTP succeeds.
    assert.equal((await rpc<{ profile: { username: string } }>(aliceCookie, 'query', 'wyre.session')).profile.username, 'alice_wyre');
    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: aliceEmail });
    const totpLoginOutputStart = output.length;
    assert.equal((await json('/api/auth/send-code', { email: aliceEmail })).status, 200);
    const totpLogin = await json<{ ok: true }>('/api/auth/verify-code', {
      email: aliceEmail,
      code: await codeFor(aliceEmail, totpLoginOutputStart),
    });
    assert.ok(totpLogin.cookie);
    await rpc(totpLogin.cookie, 'mutation', 'wyre.verifyUsername', { username: 'alice_wyre' });
    await rpc(totpLogin.cookie, 'mutation', 'wyre.verifyPhone', { phone: '+7 999 123-45-67' });
    const totpGate = await rpc<{ needsTotp: boolean; profile: null }>(totpLogin.cookie, 'query', 'wyre.session');
    assert.equal(totpGate.needsTotp, true);
    assert.equal(totpGate.profile, null);
    const deniedBeforeTotp = await json<{ error: { code: string } }>(
      '/api/rpc/query',
      { method: 'wyre.listChats', args: {} },
      totpLogin.cookie,
    );
    assert.equal(deniedBeforeTotp.status, 403);
    assert.equal(deniedBeforeTotp.body.error.code, 'TOTP_REQUIRED');
    /*
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedTotp = await rpcError(totpLogin.cookie, 'mutation', 'wyre.verifyTotpLogin', { code: '000000' });
      assert.equal(failedTotp.body.error?.code, attempt === 4 ? 'TOTP_LOCKED' : 'INVALID_TOTP');
    }
    assert.equal((await rpc<{ authenticated: boolean }>(totpLogin.cookie, 'query', 'wyre.session')).authenticated, false);
    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: aliceEmail });
    const retryTotpOutput = output.length;
    await json('/api/auth/send-code', { email: aliceEmail });
    const retryTotp = await json<{ ok: true }>('/api/auth/verify-code', { email: aliceEmail, code: await codeFor(aliceEmail, retryTotpOutput) });
    assert.ok(retryTotp.cookie);
    await rpc(retryTotp.cookie, 'mutation', 'wyre.verifyUsername', { username: 'alice_wyre' });
    await rpc(retryTotp.cookie, 'mutation', 'wyre.verifyPhone', { phone: '+7 999 123-45-67' });
    await rpc(retryTotp.cookie, 'mutation', 'wyre.verifyTotpLogin', { code: await generateTotp({ secret: totpSecret }) });
    aliceCookie = retryTotp.cookie;
    */
    await rpc(totpLogin.cookie, 'mutation', 'wyre.verifyTotpLogin', { code: await generateTotp({ secret: totpSecret }) });
    aliceCookie = totpLogin.cookie;
    assert.equal((await rpc<{ profile: { username: string } }>(aliceCookie, 'query', 'wyre.session')).profile.username, 'alice_wyre');

    await rpc(aliceCookie, 'mutation', 'wyre.disableTotp', { code: await generateTotp({ secret: totpSecret }) });
    assert.equal((await rpc<{ enabled: boolean }>(aliceCookie, 'query', 'wyre.totpStatus')).enabled, false);

    // PIN is stored as a salted/peppered scrypt hash. Enabling it trusts only
    // the current session; every subsequent login receives a separate gate.
    await rpc(aliceCookie, 'mutation', 'wyre.setPin', { pin: '2468' });
    await rpc(aliceCookie, 'mutation', 'wyre.setDecoyCode', { code: '1357' });
    const publicPinSettings = await rpc<Record<string, unknown>>(aliceCookie, 'query', 'wyre.settings');
    assert.equal(publicPinSettings.pinEnabled, true);
    assert.equal(publicPinSettings.decoyEnabled, true);
    assert.equal('pinSalt' in publicPinSettings, false);
    assert.equal('pinHash' in publicPinSettings, false);
    assert.equal('totpSecretEncrypted' in publicPinSettings, false);
    assert.equal('decoyUserId' in publicPinSettings, false);
    assert.equal('decoyHash' in publicPinSettings, false);
    const storedPinSettings = await mongoClient.db(dbName).collection('wyreSettings').findOne({ userId: peopleForBob[0].userId });
    assert.equal(storedPinSettings?.pinEnabled, true);
    assert.notEqual(storedPinSettings?.pinHash, '2468');
    assert.ok(storedPinSettings?.pinSalt);

    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: aliceEmail });
    const pinLoginOutputStart = output.length;
    await json('/api/auth/send-code', { email: aliceEmail });
    const pinLogin = await json<{ ok: true }>('/api/auth/verify-code', { email: aliceEmail, code: await codeFor(aliceEmail, pinLoginOutputStart) });
    assert.ok(pinLogin.cookie);
    await rpc(pinLogin.cookie, 'mutation', 'wyre.verifyUsername', { username: 'alice_wyre' });
    await rpc(pinLogin.cookie, 'mutation', 'wyre.verifyPhone', { phone: '+7 999 123-45-67' });
    const pinGate = await rpc<{ needsPin: boolean; needsTotp: boolean; profile: null }>(pinLogin.cookie, 'query', 'wyre.session');
    assert.equal(pinGate.needsPin, true);
    assert.equal(pinGate.needsTotp, false);
    assert.equal(pinGate.profile, null);
    const deniedBeforePin = await rpcError(pinLogin.cookie, 'query', 'wyre.listChats');
    assert.equal(deniedBeforePin.body.error?.code, 'PIN_REQUIRED');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedPin = await rpcError(pinLogin.cookie, 'mutation', 'wyre.verifyPinLogin', { pin: '0000' });
      assert.equal(failedPin.body.error?.code, attempt === 4 ? 'PIN_LOCKED' : 'INVALID_PIN');
    }
    assert.equal((await rpc<{ authenticated: boolean }>(pinLogin.cookie, 'query', 'wyre.session')).authenticated, false);

    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: aliceEmail });
    const retryPinOutputStart = output.length;
    await json('/api/auth/send-code', { email: aliceEmail });
    const retryPin = await json<{ ok: true }>('/api/auth/verify-code', { email: aliceEmail, code: await codeFor(aliceEmail, retryPinOutputStart) });
    assert.ok(retryPin.cookie);
    await rpc(retryPin.cookie, 'mutation', 'wyre.verifyUsername', { username: 'alice_wyre' });
    await rpc(retryPin.cookie, 'mutation', 'wyre.verifyPhone', { phone: '+7 999 123-45-67' });
    await rpc(retryPin.cookie, 'mutation', 'wyre.verifyPinLogin', { pin: '2468' });
    aliceCookie = retryPin.cookie;
    assert.equal((await rpc<{ profile: { username: string } }>(aliceCookie, 'query', 'wyre.session')).profile.username, 'alice_wyre');

    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: aliceEmail });
    const decoyLoginOutputStart = output.length;
    await json('/api/auth/send-code', { email: aliceEmail });
    const decoyLogin = await json<{ ok: true }>('/api/auth/verify-code', { email: aliceEmail, code: await codeFor(aliceEmail, decoyLoginOutputStart) });
    assert.ok(decoyLogin.cookie);
    await rpc(decoyLogin.cookie, 'mutation', 'wyre.verifyUsername', { username: 'alice_wyre' });
    await rpc(decoyLogin.cookie, 'mutation', 'wyre.verifyPhone', { phone: '+7 999 123-45-67' });
    await rpc(decoyLogin.cookie, 'mutation', 'wyre.verifyPinLogin', { pin: '1357' });
    const decoySession = await rpc<{ profile: { username: string; name: string } }>(decoyLogin.cookie, 'query', 'wyre.session');
    assert.notEqual(decoySession.profile.username, 'alice_wyre');
    assert.equal(decoySession.profile.name, 'Алиса');
    assert.deepEqual(await rpc<unknown[]>(decoyLogin.cookie, 'query', 'wyre.listChats'), []);
    const decoyProfile = await mongoClient.db(dbName).collection('wyreProfiles').findOne({ username: decoySession.profile.username });
    assert.equal(decoyProfile?.isDecoy, true);
    assert.equal((await rpc<{ userId: string }[]>(bobCookie, 'query', 'wyre.searchPeople', { query: '' })).some((person) => person.userId === decoyProfile?.userId.toString()), false);

    const activeSessions = await rpc<{ id: string; current: boolean; device: string }[]>(aliceCookie, 'query', 'wyre.activeSessions');
    assert.ok(activeSessions.some((session) => session.current));
    const oldSession = activeSessions.find((session) => !session.current);
    if (oldSession) {
      await rpc(aliceCookie, 'mutation', 'wyre.revokeSession', { sessionId: oldSession.id });
      assert.equal((await rpc<{ id: string }[]>(aliceCookie, 'query', 'wyre.activeSessions')).some((session) => session.id === oldSession.id), false);
    }
    const exportTxt = await fetch(`${baseUrl}/api/export/txt`, { headers: { Cookie: aliceCookie } });
    assert.equal(exportTxt.status, 200);
    assert.match(await exportTxt.text(), /Wyre export/);
    const exportJson = await fetch(`${baseUrl}/api/export/json`, { headers: { Cookie: aliceCookie } });
    assert.equal(exportJson.status, 200);
    const exportPayload = await exportJson.json() as {
      schema: string;
      settings: Record<string, unknown>;
      messages: unknown[];
      attachments: unknown[];
      sessions: Record<string, unknown>[];
      sharedNotes: { chatId: string; content: string }[];
    };
    assert.equal(exportPayload.schema, 'wyre-export-v2');
    assert.ok(exportPayload.messages.length > 0);
    assert.ok(exportPayload.attachments.length > 0);
    assert.ok(exportPayload.sharedNotes.some((note) => note.chatId === chatId && note.content === 'Купить продукты и позвонить родным'));
    assert.equal('totpSecretEncrypted' in exportPayload.settings, false);
    assert.equal('pinSalt' in exportPayload.settings, false);
    assert.equal('pinHash' in exportPayload.settings, false);
    assert.equal(exportPayload.sessions.some((session) => 'tokenHash' in session), false);
    const storageUsage = await rpc<{ bytes: number; fileCount: number }>(aliceCookie, 'query', 'wyre.storageUsage');
    assert.ok(storageUsage.bytes > 0);
    assert.ok(storageUsage.fileCount > 0);

    const exportPdf = await fetch(`${baseUrl}/api/export/pdf`, { headers: { Cookie: aliceCookie } });
    assert.equal(exportPdf.status, 200);
    assert.equal(Buffer.from(await exportPdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    await rpc(aliceCookie, 'mutation', 'wyre.disableDecoy', { code: '1357' });
    await rpc(aliceCookie, 'mutation', 'wyre.disablePin', { pin: '2468' });
    assert.equal((await rpc<{ enabled: boolean }>(aliceCookie, 'query', 'wyre.pinStatus')).enabled, false);

    // Account passwords: login password replaces the emailed code, the additional
    // password is a separate post-login gate, and neither bypasses other checks.
    assert.equal((await rpc<{ loginPasswordEnabled: boolean; additionalPasswordEnabled: boolean; yandexLinked: boolean }>(aliceCookie, 'query', 'wyre.accountAuthStatus')).loginPasswordEnabled, false);
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.setLoginPassword', { password: 'short' })).status, 400);
    await rpc(aliceCookie, 'mutation', 'wyre.setLoginPassword', { password: 'wyre-family-login-2026' });
    assert.equal((await rpc<{ loginPasswordEnabled: boolean }>(aliceCookie, 'query', 'wyre.accountAuthStatus')).loginPasswordEnabled, true);
    assert.equal((await json('/api/auth/password', { email: aliceEmail, password: 'wrong-password-value' })).status, 400);
    const passwordLogin = await json<{ ok: true }>('/api/auth/password', { email: aliceEmail, password: 'wyre-family-login-2026' });
    assert.equal(passwordLogin.status, 200);
    assert.ok(passwordLogin.cookie);
    // Password login still has to pass the existing username/phone challenge.
    assert.equal((await rpc<{ needsChallenge: boolean }>(passwordLogin.cookie, 'query', 'wyre.session')).needsChallenge, true);
    await rpc(passwordLogin.cookie, 'mutation', 'wyre.verifyUsername', { username: 'alice_wyre' });
    await rpc(passwordLogin.cookie, 'mutation', 'wyre.verifyPhone', { phone: '+7 999 123-45-67' });
    assert.equal((await rpc<{ profile: { username: string } }>(passwordLogin.cookie, 'query', 'wyre.session')).profile.username, 'alice_wyre');
    aliceCookie = passwordLogin.cookie;

    await rpc(aliceCookie, 'mutation', 'wyre.setAdditionalPassword', { password: 'wyre-second-secret-2026' });
    const additionalOutputStart = output.length;
    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: aliceEmail });
    await json('/api/auth/send-code', { email: aliceEmail });
    const additionalLogin = await json<{ ok: true }>('/api/auth/verify-code', { email: aliceEmail, code: await codeFor(aliceEmail, additionalOutputStart) });
    assert.ok(additionalLogin.cookie);
    await rpc(additionalLogin.cookie, 'mutation', 'wyre.verifyUsername', { username: 'alice_wyre' });
    await rpc(additionalLogin.cookie, 'mutation', 'wyre.verifyPhone', { phone: '+7 999 123-45-67' });
    assert.equal((await rpc<{ needsAdditionalPassword: boolean; profile: null }>(additionalLogin.cookie, 'query', 'wyre.session')).needsAdditionalPassword, true);
    assert.equal((await rpcError(additionalLogin.cookie, 'query', 'wyre.listChats')).body.error?.code, 'ADDITIONAL_PASSWORD_REQUIRED');
    assert.equal((await rpcError(additionalLogin.cookie, 'mutation', 'wyre.verifyAdditionalPasswordLogin', { password: 'definitely-wrong-secret' })).body.error?.code, 'INVALID_ADDITIONAL_PASSWORD');
    await rpc(additionalLogin.cookie, 'mutation', 'wyre.verifyAdditionalPasswordLogin', { password: 'wyre-second-secret-2026' });
    assert.equal((await rpc<{ profile: { username: string } }>(additionalLogin.cookie, 'query', 'wyre.session')).profile.username, 'alice_wyre');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await rpcError(additionalLogin.cookie, 'mutation', 'wyre.verifyAdditionalPasswordLogin', { password: 'definitely-wrong-secret' });
    }
    assert.equal((await rpcError(additionalLogin.cookie, 'mutation', 'wyre.verifyAdditionalPasswordLogin', { password: 'definitely-wrong-secret' })).body.error?.code, 'ADDITIONAL_PASSWORD_LOCKED');
    assert.equal((await rpc<{ authenticated: boolean }>(additionalLogin.cookie, 'query', 'wyre.session')).authenticated, false);
    await rpc(aliceCookie, 'mutation', 'wyre.disableAdditionalPassword', { password: 'wyre-second-secret-2026' });
    await rpc(aliceCookie, 'mutation', 'wyre.disableLoginPassword', { password: 'wyre-family-login-2026' });
    assert.equal((await json('/api/auth/password', { email: aliceEmail, password: 'wyre-family-login-2026' })).status, 400);

    // Yandex link/unlink stays authenticated and never leaks secrets.
    assert.equal((await rpc<{ yandexLinked: boolean; canUnlinkYandex: boolean }>(aliceCookie, 'query', 'wyre.accountAuthStatus')).yandexLinked, false);
    assert.equal((await rpc<{ linked: boolean }>(aliceCookie, 'mutation', 'wyre.unlinkYandex')).linked, false);
    assert.equal((await fetch(`${baseUrl}/auth/yandex/link`, { redirect: 'manual' })).status, 503);
    await mongoClient.db(dbName).collection('wyreUsers').updateOne({ email: aliceEmail }, { $set: { yandexId: 'integration-yandex-id' } });
    assert.equal((await rpc<{ yandexLinked: boolean; canUnlinkYandex: boolean }>(aliceCookie, 'query', 'wyre.accountAuthStatus')).yandexLinked, true);
    assert.equal((await rpcError('', 'mutation', 'wyre.unlinkYandex')).status, 401);
    assert.equal((await rpc<{ linked: boolean }>(aliceCookie, 'mutation', 'wyre.unlinkYandex')).linked, false);
    assert.equal((await mongoClient.db(dbName).collection('wyreUsers').findOne({ email: aliceEmail }))?.yandexId, undefined);

    // Restore imports only the account's own personal entities.
    const restoreSource = await (await fetch(`${baseUrl}/api/export/json`, { headers: { Cookie: aliceCookie } })).json() as Record<string, unknown>;
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.validateBackup', { backup: restoreSource })).body.error?.code, 'BACKUP_ACCOUNT_MISMATCH');
    assert.equal((await rpcError(aliceCookie, 'mutation', 'wyre.validateBackup', {
      backup: { ...restoreSource, settings: { ...(restoreSource.settings as Record<string, unknown>), pinHash: 'stolen' } },
    })).body.error?.code, 'BACKUP_CONTAINS_SECRETS');
    const restoreBackupPayload = {
      ...restoreSource,
      profile: { ...(restoreSource.profile as Record<string, unknown>), bio: 'Восстановленное био' },
      drafts: [
        { chatId, text: 'Восстановленный черновик' },
        { chatId: new ObjectId().toString(), text: 'Черновик чужого чата' },
      ],
      reminders: [{ chatId, messageId: englishMessage.messageId, text: 'Восстановленное напоминание', remindAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() }],
      scheduledMessages: [{ chatId, text: 'Восстановленная отложенная отправка', scheduledAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() }],
      messages: [],
    };
    const restorePlan = await rpc<{ plan: { drafts: number; reminders: number; scheduledMessages: number } }>(aliceCookie, 'mutation', 'wyre.validateBackup', { backup: restoreBackupPayload });
    assert.equal(restorePlan.plan.drafts, 1);
    assert.equal(restorePlan.plan.reminders, 1);
    assert.equal(restorePlan.plan.scheduledMessages, 1);
    await rpc(aliceCookie, 'mutation', 'wyre.restoreBackup', { backup: restoreBackupPayload });
    // Idempotent: repeating the same restore must not duplicate anything.
    await rpc(aliceCookie, 'mutation', 'wyre.restoreBackup', { backup: restoreBackupPayload });
    assert.equal(await rpc<string>(aliceCookie, 'query', 'wyre.draft', { chatId }), 'Восстановленный черновик');
    assert.equal((await rpc<{ text: string }[]>(aliceCookie, 'query', 'wyre.reminders', { chatId })).filter((reminder) => reminder.text === 'Восстановленное напоминание').length, 1);
    assert.equal((await rpc<{ text: string }[]>(aliceCookie, 'query', 'wyre.scheduledMessages', { chatId })).filter((item) => item.text === 'Восстановленная отложенная отправка').length, 1);
    assert.equal((await rpc<{ profile: { bio: string } }>(aliceCookie, 'query', 'wyre.session')).profile.bio, 'Восстановленное био');
    await rpc(aliceCookie, 'mutation', 'wyre.clearDraft', { chatId });

    // WebAuthn challenges are server-generated, bound to one session and
    // consumed even when the authenticator response is invalid.
    const registrationOptions = await rpc<{ challenge: string; rp: { id: string } }>(aliceCookie, 'mutation', 'wyre.beginWebAuthnRegistration', { scope: 'account' });
    assert.ok(registrationOptions.challenge.length > 20);
    assert.equal(registrationOptions.rp.id, '127.0.0.1');
    const invalidWebAuthn = await rpcError(aliceCookie, 'mutation', 'wyre.finishWebAuthnRegistration', {
      response: { id: 'invalid', rawId: 'invalid', type: 'public-key', response: {} },
    });
    assert.equal(invalidWebAuthn.body.error?.code, 'INVALID_WEBAUTHN_RESPONSE');
    const replayedWebAuthn = await rpcError(aliceCookie, 'mutation', 'wyre.finishWebAuthnRegistration', {
      response: { id: 'invalid', rawId: 'invalid', type: 'public-key', response: {} },
    });
    assert.equal(replayedWebAuthn.body.error?.code, 'WEBAUTHN_CHALLENGE_EXPIRED');

    // Optional double confirmation leaves the new session unable to read any
    // private data until an already approved device accepts it.
    await rpc(aliceCookie, 'mutation', 'wyre.setNewDeviceApproval', { enabled: true });
    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: aliceEmail });
    const approvalLoginOutputStart = output.length;
    await json('/api/auth/send-code', { email: aliceEmail });
    const approvalLogin = await json<{ ok: true }>('/api/auth/verify-code', { email: aliceEmail, code: await codeFor(aliceEmail, approvalLoginOutputStart) });
    assert.ok(approvalLogin.cookie);
    await rpc(approvalLogin.cookie, 'mutation', 'wyre.verifyUsername', { username: 'alice_wyre' });
    await rpc(approvalLogin.cookie, 'mutation', 'wyre.verifyPhone', { phone: '+7 999 123-45-67' });
    const approvalGate = await rpc<{ needsDeviceApproval: boolean; profile: null }>(approvalLogin.cookie, 'query', 'wyre.session');
    assert.equal(approvalGate.needsDeviceApproval, true);
    assert.equal(approvalGate.profile, null);
    assert.equal((await rpcError(approvalLogin.cookie, 'query', 'wyre.listChats')).body.error?.code, 'DEVICE_APPROVAL_REQUIRED');
    const pendingApproval = (await rpc<{ id: string; approved: boolean; current: boolean }[]>(aliceCookie, 'query', 'wyre.activeSessions'))
      .find((session) => !session.approved && !session.current);
    assert.ok(pendingApproval);
    await rpc(aliceCookie, 'mutation', 'wyre.approveDeviceSession', { sessionId: pendingApproval.id });
    assert.equal((await rpc<{ profile: { username: string } }>(approvalLogin.cookie, 'query', 'wyre.session')).profile.username, 'alice_wyre');
    await rpc(aliceCookie, 'mutation', 'wyre.setNewDeviceApproval', { enabled: false });

    const qrLogin = await rpc<{ token: string; url: string }>(aliceCookie, 'mutation', 'wyre.createQrLogin');
    const qrResponse = await fetch(`${baseUrl}/auth/qr?token=${encodeURIComponent(qrLogin.token)}`, { redirect: 'manual', headers: { 'User-Agent': 'Wyre QR Integration Device' } });
    assert.equal(qrResponse.status, 302);
    const qrCookie = (typeof qrResponse.headers.getSetCookie === 'function' ? qrResponse.headers.getSetCookie() : [qrResponse.headers.get('set-cookie') ?? ''])
      .map((value) => value.split(';')[0])
      .find((value) => value.startsWith('wyre_session='));
    assert.ok(qrCookie);
    assert.equal((await rpc<{ authenticated: boolean }>(qrCookie, 'query', 'wyre.session')).authenticated, true);
    const reusedQr = await fetch(`${baseUrl}/auth/qr?token=${encodeURIComponent(qrLogin.token)}`, { redirect: 'manual' });
    assert.match(reusedQr.headers.get('location') ?? '', /authError=/);

    // Web push: subscription is bound to the session, the server decides delivery
    // and gone endpoints are dropped automatically.
    const pushStatus = await rpc<{ configured: boolean; publicKey: string | null; currentDeviceSubscribed: boolean }>(bobCookie, 'query', 'wyre.pushStatus');
    assert.equal(pushStatus.configured, true);
    assert.ok(pushStatus.publicKey);
    assert.equal(pushStatus.currentDeviceSubscribed, false);
    const pushKeys = { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', auth: 'k8JV6sjdbhAi1n3_LDBLvA' };
    await rpc(bobCookie, 'mutation', 'wyre.subscribePush', { endpoint: `https://127.0.0.1:${pushPort}/push-endpoint`, keys: pushKeys, userAgent: 'Integration Device' });
    assert.equal((await rpc<{ currentDeviceSubscribed: boolean; deviceCount: number }>(bobCookie, 'query', 'wyre.pushStatus')).currentDeviceSubscribed, true);
    const deliveriesBefore = pushDeliveries;
    await rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Уведомление для Боба', kind: 'text' });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (pushDeliveries > deliveriesBefore) break;
      await delay(1000);
    }
    assert.ok(pushDeliveries > deliveriesBefore, 'push notification was not delivered');
    // A muted chat must not generate any push job at all.
    await rpc(bobCookie, 'mutation', 'wyre.updateChatNotifications', { chatId, mode: 'none' });
    const mutedMessage = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Сообщение в выключенном чате', kind: 'text' });
    await delay(500);
    assert.equal(await mongoClient.db(dbName).collection('wyreNotificationJobs').countDocuments({ eventId: mutedMessage.messageId }), 0);
    await rpc(bobCookie, 'mutation', 'wyre.updateChatNotifications', { chatId, mode: 'all' });
    // Gone endpoints are removed on 410.
    await rpc(bobCookie, 'mutation', 'wyre.unsubscribePush', {});
    await rpc(bobCookie, 'mutation', 'wyre.subscribePush', { endpoint: `https://127.0.0.1:${pushPort}/push-gone`, keys: pushKeys });
    await rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Сообщение для устаревшей подписки', kind: 'text' });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (pushGoneRequests > 0 && (await rpc<{ deviceCount: number }>(bobCookie, 'query', 'wyre.pushStatus')).deviceCount === 0) break;
      await delay(1000);
    }
    assert.ok(pushGoneRequests > 0);
    assert.equal((await rpc<{ deviceCount: number }>(bobCookie, 'query', 'wyre.pushStatus')).deviceCount, 0);
    await rpc(bobCookie, 'mutation', 'wyre.markChatRead', { chatId });

    // Memory album groups the real conversation media into a timeline.
    const memoryTicket = await rpc<{ url: string; fields: Record<string, string>; filePath: string }>(aliceCookie, 'mutation', 'wyre.requestAttachmentUpload', {
      chatId, fileName: 'memory.png', fileSize: 8, contentType: 'image/png',
    });
    const memoryForm = new FormData();
    for (const [key, value] of Object.entries(memoryTicket.fields)) memoryForm.append(key, value);
    memoryForm.append('file', new Blob(['png-data'], { type: 'image/png' }), 'memory.png');
    assert.equal((await fetch(`${baseUrl}${memoryTicket.url}`, { method: 'POST', headers: { Cookie: aliceCookie }, body: memoryForm })).status, 201);
    await rpc(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Общее фото', kind: 'file', filePath: memoryTicket.filePath, mimeType: 'image/png', fileName: 'memory.png', fileSize: '8 Б' });
    const memoryAlbum = await rpc<{
      total: number;
      firstAt: string | null;
      periods: { period: string; label: string; items: { id: string; url?: string; mine: boolean; author: string }[] }[];
    }>(aliceCookie, 'query', 'wyre.memoryAlbum', { chatId });
    assert.ok(memoryAlbum.total > 0);
    assert.ok(memoryAlbum.periods.length >= 1);
    assert.ok(memoryAlbum.periods[0].items.every((item) => Boolean(item.url)));
    assert.ok(memoryAlbum.periods.flatMap((period) => period.items).some((item) => item.mine));
    assert.equal((await rpcError(charlieCookie, 'query', 'wyre.memoryAlbum', { chatId })).status, 400);

    // In-tab viewing needs HTTP Range support and an explicit download mode.
    const mediaUrl = memoryAlbum.periods[0].items[0].url!;
    const rangeResponse = await fetch(`${baseUrl}${mediaUrl}`, { headers: { Cookie: aliceCookie, Range: 'bytes=0-3' } });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get('content-range'), 'bytes 0-3/8');
    assert.equal(rangeResponse.headers.get('accept-ranges'), 'bytes');
    assert.equal((await rangeResponse.text()).length, 4);
    const inlineResponse = await fetch(`${baseUrl}${mediaUrl}`, { headers: { Cookie: aliceCookie } });
    assert.equal(inlineResponse.headers.get('content-disposition'), 'inline');
    assert.equal(inlineResponse.headers.get('content-length'), '8');
    const downloadResponse = await fetch(`${baseUrl}${mediaUrl}&download=1`, { headers: { Cookie: aliceCookie } });
    assert.match(downloadResponse.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal((await fetch(`${baseUrl}${mediaUrl}`)).status, 401);

    // Server-side chat search covers history, attachment names and transcripts.
    const searchByText = await rpc<{ id: string; text: string }[]>(aliceCookie, 'query', 'wyre.searchMessages', { chatId, query: 'Общее фото' });
    assert.ok(searchByText.some((result) => result.text.includes('Общее фото')));
    const searchByFileName = await rpc<{ id: string; text: string }[]>(aliceCookie, 'query', 'wyre.searchMessages', { chatId, query: 'memory.png' });
    assert.ok(searchByFileName.length > 0);
    const searchByTranscript = await rpc<{ id: string }[]>(aliceCookie, 'query', 'wyre.searchMessages', { chatId, query: 'Расшифрованное' });
    assert.ok(searchByTranscript.some((result) => result.id === voiceRoot.messageId));
    assert.equal((await rpc<unknown[]>(aliceCookie, 'query', 'wyre.searchMessages', { chatId, query: 'этого-точно-нет-в-чате' })).length, 0);
    assert.equal((await rpcError(charlieCookie, 'query', 'wyre.searchMessages', { chatId, query: 'фото' })).status, 400);

    // Quiet care is opt-in by the subject and only reaches real contacts.
    assert.equal((await rpc<{ enabled: boolean; days: number }>(bobCookie, 'query', 'wyre.quietCareSettings')).enabled, false);
    await rpc(bobCookie, 'mutation', 'wyre.setQuietCare', { enabled: true, days: 3 });
    assert.deepEqual(await rpc(bobCookie, 'query', 'wyre.quietCareSettings'), { enabled: true, days: 3 });
    await mongoClient.db(dbName).collection('wyreProfiles').updateOne(
      { username: 'bob_wyre' },
      { $set: { lastSeenAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) } },
    );
    let careAlerts: { id: string; name: string; days: number }[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      careAlerts = await rpc(aliceCookie, 'query', 'wyre.quietCareAlerts');
      if (careAlerts.length) break;
      await delay(1000);
    }
    assert.equal(careAlerts[0]?.name, 'Боб');
    assert.equal(careAlerts[0]?.days, 3);
    // Someone without a direct chat must not receive the alert.
    assert.equal((await rpc<unknown[]>(charlieCookie, 'query', 'wyre.quietCareAlerts')).length, 0);
    await rpc(aliceCookie, 'mutation', 'wyre.dismissQuietCareAlert', { alertId: careAlerts[0].id });
    assert.equal((await rpc<unknown[]>(aliceCookie, 'query', 'wyre.quietCareAlerts')).length, 0);
    // Coming back online clears pending alerts automatically.
    await mongoClient.db(dbName).collection('wyreQuietCareAlerts').deleteMany({});
    await mongoClient.db(dbName).collection('wyreProfiles').updateOne({ username: 'bob_wyre' }, { $set: { lastSeenAt: new Date() } });
    await rpc(bobCookie, 'mutation', 'wyre.setQuietCare', { enabled: false, days: 3 });
    assert.equal((await rpc<{ enabled: boolean }>(bobCookie, 'query', 'wyre.quietCareSettings')).enabled, false);

    // Device identity: sessions from one browser profile share a device record,
    // admin device bans revoke access and cascade only on explicit request.
    const deviceProbe = await fetch(`${baseUrl}/api/health`);
    const probeCookies = typeof deviceProbe.headers.getSetCookie === 'function'
      ? deviceProbe.headers.getSetCookie()
      : (deviceProbe.headers.get('set-cookie') ? [deviceProbe.headers.get('set-cookie') as string] : []);
    const deviceCookie = probeCookies.map((value) => value.split(';')[0]).find((value) => value.startsWith('wyre_device='));
    assert.ok(deviceCookie);
    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: charlieEmail });
    const deviceLoginStart = output.length;
    await json('/api/auth/send-code', { email: charlieEmail });
    const deviceLogin = await json<{ ok: true }>('/api/auth/verify-code', { email: charlieEmail, code: await codeFor(charlieEmail, deviceLoginStart) }, deviceCookie);
    assert.ok(deviceLogin.cookie);
    const charlieDeviceCookie = `${deviceLogin.cookie}; ${deviceCookie}`;
    await rpc(charlieDeviceCookie, 'mutation', 'wyre.verifyUsername', { username: 'charlie_wyre' });
    assert.equal((await rpc<{ profile: { username: string } }>(charlieDeviceCookie, 'query', 'wyre.session')).profile.username, 'charlie_wyre');

    const charlieAdmin = (await rpc<{ id: string; username: string }[]>(aliceCookie, 'query', 'wyre.adminUsers', { query: 'charlie' }))[0];
    assert.ok(charlieAdmin);
    const charlieDevices = await rpc<{ deviceId: string; activeSessions: number; accountCount: number; banned: boolean }[]>(aliceCookie, 'query', 'wyre.adminUserDevices', { targetId: charlieAdmin.id });
    assert.ok(charlieDevices.length >= 1);
    const targetDevice = charlieDevices[0];
    assert.ok(targetDevice.activeSessions >= 1);
    assert.equal(targetDevice.banned, false);
    assert.equal((await rpcError(charlieCookie, 'query', 'wyre.adminUserDevices', { targetId: charlieAdmin.id })).status, 403);
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.banDevice', { deviceId: targetDevice.deviceId, targetId: charlieAdmin.id, reason: 'нет прав' })).status, 403);
    assert.equal((await rpc<{ profileId: string; username: string }[]>(aliceCookie, 'query', 'wyre.adminDeviceAccounts', { deviceId: targetDevice.deviceId })).some((entry) => entry.username === '@charlie_wyre'), true);

    await rpc(aliceCookie, 'mutation', 'wyre.banDevice', { deviceId: targetDevice.deviceId, targetId: charlieAdmin.id, reason: 'Проверка блокировки устройства' });
    assert.equal((await rpc<{ authenticated: boolean }>(charlieDeviceCookie, 'query', 'wyre.session')).authenticated, false);
    // A banned device cannot start a new session either.
    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: charlieEmail });
    const blockedLoginStart = output.length;
    await json('/api/auth/send-code', { email: charlieEmail });
    const blockedLogin = await json<{ error?: { code: string } }>('/api/auth/verify-code', { email: charlieEmail, code: await codeFor(charlieEmail, blockedLoginStart) }, deviceCookie);
    assert.equal(blockedLogin.status, 403);
    assert.equal(blockedLogin.body.error?.code, 'DEVICE_BANNED');
    await rpc(aliceCookie, 'mutation', 'wyre.unbanDevice', { deviceId: targetDevice.deviceId, targetId: charlieAdmin.id });
    assert.equal((await rpc<{ banned: boolean }[]>(aliceCookie, 'query', 'wyre.adminUserDevices', { targetId: charlieAdmin.id }))[0].banned, false);
    // Cascade requires admin rights and covers all devices of the account; a timed ban records its expiry.
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.banUser', { targetId: charlieAdmin.id, durationMinutes: 60, reason: 'нет прав на каскад', cascadeDevices: true })).status, 403);
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.banUser', { targetId: charlieAdmin.id, durationMinutes: null, reason: 'нет прав на вечный бан' })).status, 403);
    const cascade = await rpc<{ bannedDevices: number }>(aliceCookie, 'mutation', 'wyre.banUser', { targetId: charlieAdmin.id, durationMinutes: 90, reason: 'Каскадная проверка', cascadeDevices: true });
    assert.ok(cascade.bannedDevices >= 1);
    const timedBan = (await rpc<{ banned: boolean; bannedUntil: string | null }[]>(aliceCookie, 'query', 'wyre.adminUsers', { query: 'charlie' }))[0];
    assert.equal(timedBan.banned, true);
    assert.ok(timedBan.bannedUntil && new Date(timedBan.bannedUntil).getTime() > Date.now() && new Date(timedBan.bannedUntil).getFullYear() < 9999);
    assert.equal((await rpc<{ banned: boolean }[]>(aliceCookie, 'query', 'wyre.adminUserDevices', { targetId: charlieAdmin.id })).every((device) => device.banned), true);
    await rpc(aliceCookie, 'mutation', 'wyre.unbanUser', { targetId: charlieAdmin.id });
    await rpc(aliceCookie, 'mutation', 'wyre.unbanDevice', { deviceId: targetDevice.deviceId, targetId: charlieAdmin.id });

    // Push action tokens: the web app hands an opaque token to the Android
    // shell, whose notification buttons then act through /api/push-action/*
    // without holding the session cookie. A wrong token is rejected.
    const actionToken = (await rpc<{ token: string }>(bobCookie, 'mutation', 'wyre.createPushActionToken', {})).token;
    assert.ok(actionToken.length >= 20);
    assert.equal((await json('/api/push-action/read', { token: actionToken, chatId })).status, 200);
    assert.equal((await json('/api/push-action/read', { token: 'not-a-real-action-token-value', chatId })).status, 401);

    // Admin account deletion: a disposable account is wiped together with its
    // direct chats, sessions and profile; moderators cannot delete accounts.
    const daveCookie = await register('dave@example.com', 'Дэйв', 'dave_wyre');
    const bobPerson = (await rpc<{ userId: string }[]>(daveCookie, 'query', 'wyre.searchPeople', { query: 'bob' }))[0];
    assert.ok(bobPerson);
    const daveBobChat = (await rpc<{ chatId: string }>(daveCookie, 'mutation', 'wyre.openDirectChat', { peerId: bobPerson.userId })).chatId;
    assert.equal((await rpc<{ id: string }[]>(bobCookie, 'query', 'wyre.listChats')).some((chat) => chat.id === daveBobChat), true);
    const daveAdmin = (await rpc<{ id: string }[]>(aliceCookie, 'query', 'wyre.adminUsers', { query: 'dave' }))[0];
    assert.ok(daveAdmin);
    assert.equal((await rpcError(bobCookie, 'mutation', 'wyre.deleteUserAccount', { targetId: daveAdmin.id, reason: 'нет прав на удаление аккаунта' })).status, 403);
    await rpc(aliceCookie, 'mutation', 'wyre.deleteUserAccount', { targetId: daveAdmin.id, reason: 'Проверка удаления аккаунта' });
    assert.equal((await rpc<{ authenticated: boolean }>(daveCookie, 'query', 'wyre.session')).authenticated, false);
    assert.equal((await rpc<{ id: string }[]>(aliceCookie, 'query', 'wyre.adminUsers', { query: 'dave' })).length, 0);
    assert.equal((await rpc<{ id: string }[]>(bobCookie, 'query', 'wyre.listChats')).some((chat) => chat.id === daveBobChat), false);

    const call = await rpc<{ callId: string }>(aliceCookie, 'mutation', 'wyre.startCall', { chatId, kind: 'audio' });
    const incoming = await rpc<{ callId: string; myState: string }>(bobCookie, 'query', 'wyre.callState');
    assert.equal(incoming.callId, call.callId);
    assert.equal(incoming.myState, 'invited');
    await rpc(bobCookie, 'mutation', 'wyre.acceptCall', { callId: call.callId });
    const active = await rpc<{ status: string; peers: string[]; warnings: { reason: string }[] }>(aliceCookie, 'query', 'wyre.callState');
    assert.equal(active.status, 'active');
    assert.equal(active.peers.length, 1);
    assert.equal(active.warnings[0]?.reason, 'Проверочное предупреждение');
    aliceChats = await rpc(aliceCookie, 'query', 'wyre.listChats');
    assert.equal(aliceChats.find((chat) => chat.id === chatId)?.presence, 'talking');
    await rpc(bobCookie, 'mutation', 'wyre.leaveCall', { callId: call.callId });
    await rpc(aliceCookie, 'mutation', 'wyre.leaveCall', { callId: call.callId });

    await rpc(aliceCookie, 'mutation', 'wyre.deleteChat', { chatId });
    assert.equal((await rpc<{ id: string }[]>(aliceCookie, 'query', 'wyre.listChats')).some((chat) => chat.id === chatId), false);
    assert.equal((await rpc<{ id: string }[]>(bobCookie, 'query', 'wyre.listChats')).some((chat) => chat.id === chatId), true);
    await rpc(bobCookie, 'mutation', 'wyre.sendMessage', { chatId, text: 'Возвращает скрытый чат', kind: 'text' });
    assert.equal((await rpc<{ id: string }[]>(aliceCookie, 'query', 'wyre.listChats')).some((chat) => chat.id === chatId), true);

    // Five failed secondary checks revoke the session server-side.
    await mongoClient.db(dbName).collection('wyreOtps').deleteMany({ email: bobEmail });
    const bobLoginOutputStart = output.length;
    assert.equal((await json('/api/auth/send-code', { email: bobEmail })).status, 200);
    const bobLogin = await json<{ ok: true }>('/api/auth/verify-code', {
      email: bobEmail,
      code: await codeFor(bobEmail, bobLoginOutputStart),
    });
    assert.ok(bobLogin.cookie);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await json<{ error: { code: string } }>(
        '/api/rpc/mutation',
        { method: 'wyre.verifyUsername', args: { username: 'definitely_wrong' } },
        bobLogin.cookie,
      );
      assert.equal(failed.status, 400);
    }
    const revoked = await rpc<{ authenticated: boolean }>(bobLogin.cookie, 'query', 'wyre.session');
    assert.equal(revoked.authenticated, false);

    // ----- Security hardening: injections, traversal, XSS storage, authz. -----
    // NoSQL operator objects are rejected by zod everywhere, never reach Mongo.
    assert.equal((await json('/api/auth/verify-code', { email: { $gt: '' }, code: { $ne: null } })).status, 400);
    assert.equal((await json('/api/rpc/mutation', { method: 'wyre.sendMessage', args: { chatId: { $gt: '' }, text: 'x', kind: 'text' } }, aliceCookie)).status, 400);
    assert.equal((await json('/api/rpc/query', { method: 'wyre.listMessages', args: { chatId: { $ne: null } } }, aliceCookie)).status, 400);
    assert.equal((await json('/api/rpc/query', { method: 'wyre.searchPeople', args: { query: { $regex: '.*' } } }, aliceCookie)).status, 400);
    // Path traversal: the signed file endpoint only serves whitelisted folders
    // (and requires a session in the first place).
    assert.equal((await fetch(`${baseUrl}/api/files?path=${encodeURIComponent('../../.env')}&contentType=text/plain&expires=${Date.now() + 60_000}&signature=00`, { headers: { Cookie: aliceCookie } })).status, 400);
    // Even with a VALID signature (HMAC computed with the known test secret),
    // a traversal path that escapes the upload root is rejected by the
    // whitelist + resolve check itself.
    const traversalExpires = String(Date.now() + 60_000);
    const traversalSignature = createHmac('sha256', 'integration-test-secret-with-more-than-32-characters')
      .update(`private/wyre-chats/../../../.env\n${traversalExpires}\ntext/plain`)
      .digest('hex');
    assert.equal((await fetch(`${baseUrl}/api/files?path=${encodeURIComponent('private/wyre-chats/../../../.env')}&contentType=text/plain&expires=${traversalExpires}&signature=${traversalSignature}`, { headers: { Cookie: aliceCookie } })).status, 400);
    // Attachment names are sanitized into the chat folder: the path stays
    // inside private/wyre-chats/<chatId>/ and contains no ".." path segment.
    const evilTicket = await rpc<{ filePath: string }>(aliceCookie, 'mutation', 'wyre.requestAttachmentUpload', { chatId, fileName: '../../evil.exe', fileSize: 5, contentType: 'application/octet-stream' });
    assert.match(evilTicket.filePath, /^private\/wyre-chats\/[0-9a-f]{24}\/[0-9a-f]{24}-[\w.\-]+$/);
    assert.doesNotMatch(evilTicket.filePath, /(^|\/)\.\.($|\/)/);
    // Forged and expired download signatures are rejected (valid path, wrong HMAC).
    const goodTicket = await rpc<{ filePath: string }>(aliceCookie, 'mutation', 'wyre.requestAttachmentUpload', { chatId, fileName: 'sec.txt', fileSize: 5, contentType: 'text/plain' });
    assert.equal((await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(goodTicket.filePath)}&contentType=text/plain&expires=${Date.now() + 60_000}&signature=${'0'.repeat(64)}`, { headers: { Cookie: aliceCookie } })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(goodTicket.filePath)}&contentType=text/plain&expires=1&signature=${'0'.repeat(64)}`, { headers: { Cookie: aliceCookie } })).status, 400);
    // Hostile markup is stored verbatim (data, not markup) — the client renders
    // it through React's escaping, and the API itself never returns HTML.
    const xssPayload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const xssMessage = await rpc<{ messageId: string }>(aliceCookie, 'mutation', 'wyre.sendMessage', { chatId, text: xssPayload, kind: 'text' });
    assert.equal((await rpc<{ id: string; text: string }[]>(aliceCookie, 'query', 'wyre.listMessages', { chatId })).find((message) => message.id === xssMessage.messageId)?.text, xssPayload);
    assert.equal((await fetch(`${baseUrl}/`)).headers.get('content-type')?.includes('text/html'), true);
    // Authz: nonexistent chat, anonymous mutation and a non-staff user
    // attempting account deletion are all rejected server-side.
    // (bobCookie and charlieCookie are intentionally dead here — the five-failure
    // and ban cascades above revoked those sessions, proving revocation works.)
    assert.equal((await rpcError(aliceCookie, 'query', 'wyre.listMessages', { chatId: '000000000000000000000000' })).status, 400);
    assert.equal((await rpcError('', 'mutation', 'wyre.sendMessage', { chatId, text: 'anon', kind: 'text' })).status, 401);
    const eveCookie = await register('eve@example.com', 'Ева', 'eve_wyre');
    assert.equal((await rpcError(eveCookie, 'mutation', 'wyre.deleteUserAccount', { targetId: '000000000000000000000000', reason: 'нет прав' })).status, 403);
    assert.equal((await rpcError(eveCookie, 'query', 'wyre.adminUsers', { query: '' })).status, 403);
    // Prompt-injection guard: the image marker is parsed from the assistant's
    // own reply only — a user message cannot trigger image generation directly.

    // The production bundle must boot and serve the built SPA too.
    const developmentServer = server;
    developmentServer.kill('SIGTERM');
    await once(developmentServer, 'exit');
    server = spawn(process.execPath, ['dist/server/app.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        SITE_URL: baseUrl,
        HTTPS_KEY_FILE: path.join(tlsDir, 'wyre-dev-key.pem'),
        HTTPS_CERT_FILE: path.join(tlsDir, 'wyre-dev-cert.pem'),
        MONGODB_URI: mongo.getUri(),
        MONGODB_DB_NAME: dbName,
        SESSION_SECRET: 'integration-test-secret-with-more-than-32-characters',
        EMAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.invalid.test',
        SMTP_USER: 'integration',
        SMTP_PASS: 'integration',
        EMAIL_FROM: 'Wyre <integration@example.com>',
        YANDEX_CLIENT_ID: 'integration-client-id',
        YANDEX_CLIENT_SECRET: 'integration-client-secret',
        UPLOAD_DIR: uploadDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    output = '';
    server.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    server.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await waitForServer();
    const productionPage = await fetch(`${baseUrl}/`);
    assert.equal(productionPage.status, 200);
    assert.match(await productionPage.text(), /<div id="root"><\/div>/);
    const oauthStart = await fetch(`${baseUrl}/auth/yandex`, { redirect: 'manual' });
    assert.equal(oauthStart.status, 302);
    const authorizeUrl = new URL(oauthStart.headers.get('location') ?? '');
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), `${baseUrl}/auth/yandex/callback`);

    const productionServer = server;
    productionServer.kill('SIGTERM');
    await once(productionServer, 'exit');
    server = spawn(process.execPath, ['dist/server/app.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        SITE_URL: baseUrl,
        HTTPS_DEV_CERT_DIR: tlsDir,
        MONGODB_URI: '',
        MONGODB_DB_NAME: 'wyre_embedded_test',
        MONGODB_EMBEDDED: 'true',
        MONGODB_DATA_DIR: embeddedDataDir,
        MONGODB_BINARY_DIR: mongoBinaryDir,
        SESSION_SECRET: 'integration-test-secret-with-more-than-32-characters',
        EMAIL_TRANSPORT: 'console',
        YANDEX_CLIENT_ID: '',
        YANDEX_CLIENT_SECRET: '',
        UPLOAD_DIR: uploadDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    output = '';
    server.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    server.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await waitForServer();
    assert.match(output, /Встроенная MongoDB запущена/);

    console.info('Integration test passed: auth, uniqueness, chats, AI summary/search/replies, topics, live location, folders, deletion, realtime, attachments, stories, moderation, presence, groups, albums, polls, call invites, remote control consent and security hardening.');
  } finally {
    server?.kill('SIGTERM');
    await delay(300);
    await mongoClient.close();
    await mongo.stop();
    await new Promise<void>((resolve) => transcriptionServer.close(() => resolve()));
    await new Promise<void>((resolve) => pushServer.close(() => resolve()));
    await rm(uploadDir, { recursive: true, force: true });
    await rm(embeddedDataDir, { recursive: true, force: true });
    await rm(tlsDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  if (output) console.error(output);
  process.exitCode = 1;
});
