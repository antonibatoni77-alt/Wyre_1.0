import z from 'zod';
import { ObjectId } from '../core/database';
import { env } from '../core/env';
import { AuthError, ValidationError } from '../core/errors';
import { deleteStoredFile, getUploadUrl, storedFileExists } from '../core/storage';
import type { UserInfo } from '../core/types';

import { dbProfiles, dbSettings } from './db';
import { chatQueries, chatMutations } from './chats';
import { callQueries, callMutations } from './calls';
import { storyQueries, storyMutations } from './stories';
import { moderationQueries, moderationMutations } from './moderation';
import { channelQueries, channelMutations } from './channels';
import { settingsQueries, settingsMutations } from './settings';
import { securityQueries, securityMutations } from './security';
import { accountSecurityQueries, accountSecurityMutations } from './accountSecurity';
import { notificationQueries, notificationMutations } from './notifications';
import { familyQueries, familyMutations } from './family';
import { ensureServiceChats, serviceMutations, serviceQueries } from './service';
import { maybeGenerateAiReply } from './assistant';
import { pushActionMutations } from './pushAction';
import { registerAiReplyTrigger } from './chats';

registerAiReplyTrigger((chat, userId) => maybeGenerateAiReply(chat, userId));
import {
  findProfileByUserId,
  initialsFrom,
  nameSchema,
  normalizePhone,
  paletteFor,
  phoneSetupPending,
  primaryEmail,
  registerFailedAttempt,
  requireUser,
  requireVerifiedProfile,
  serializeProfile,
  serializeProfileWithAvatar,
  usernameSchema,
} from './profile';

export { requireVerifiedProfile, markLoginChallengePending, findProfileByUserId, initialsFrom } from './profile';

export const wyreQueries = {
    ...chatQueries,
    ...callQueries,
    ...storyQueries,
    ...moderationQueries,
    ...channelQueries,
    ...settingsQueries,
    ...securityQueries,
    ...accountSecurityQueries,
    ...notificationQueries,
    ...familyQueries,
    ...serviceQueries,

    /**
     * Single source of truth for the client auth state machine:
     * whether the session is authenticated, whether the profile still has to
     * be created (fresh OTP signup) and whether the secondary challenge is due.
     */
    session: async (_args: unknown, { user }: { user: UserInfo | null }) => {
      if (!user) {
        return {
          authenticated: false,
          needsProfile: false,
          needsPhoneSetup: false,
          needsChallenge: false,
          needsTotp: false,
          needsPin: false,
          needsAdditionalPassword: false,
          needsWebAuthn: false,
          needsDeviceApproval: false,
          requiresPhone: false,
          profile: null,
        };
      }

      let profile = await findProfileByUserId(user.id);
      if (!profile) {
        return {
          authenticated: true,
          needsProfile: true,
          needsPhoneSetup: false,
          needsChallenge: false,
          needsTotp: false,
          needsPin: false,
          needsAdditionalPassword: false,
          needsWebAuthn: false,
          needsDeviceApproval: false,
          requiresPhone: false,
          profile: null,
          email: await primaryEmail(user.id),
        };
      }

      if (env.OWNER_EMAIL && profile.email === env.OWNER_EMAIL && profile.role !== 'owner') {
        await dbProfiles.updateOne({ _id: profile._id }, { $set: { role: 'owner', updatedAt: new Date() } });
        profile = await dbProfiles.requireOne({ _id: profile._id });
      }

      const needsPhoneSetup = phoneSetupPending(profile);
      const settings = await dbSettings.findOne({ userId: profile.userId.toString() });
      const needsTotp = Boolean(settings?.totpEnabled && !user.totpVerified);
      const needsPin = Boolean(settings?.pinEnabled && !user.pinVerified && !needsTotp);
      const needsAdditionalPassword = Boolean(settings?.additionalPasswordVerifier && !user.additionalPasswordVerified && !needsTotp && !needsPin);
      const needsWebAuthn = Boolean(!needsTotp && !needsPin && !needsAdditionalPassword && (
        (settings?.webauthnAccountEnabled && !user.webauthnAccountVerified)
        || (settings?.webauthnAppEnabled && !user.webauthnAppVerified)
      ));
      const needsDeviceApproval = Boolean(!needsTotp && !needsPin && !needsAdditionalPassword && !needsWebAuthn && settings?.newDeviceApprovalEnabled && !user.deviceApproved);
      if (!profile.pendingChallenge && !needsPhoneSetup && needsTotp) {
        return { authenticated: true, needsProfile: false, needsPhoneSetup: false, needsChallenge: false, needsTotp: true, needsPin: false, needsAdditionalPassword: false, needsWebAuthn: false, needsDeviceApproval: false, requiresPhone: Boolean(profile.phone), profile: null, email: profile.email };
      }
      if (!profile.pendingChallenge && !needsPhoneSetup && needsPin) {
        return { authenticated: true, needsProfile: false, needsPhoneSetup: false, needsChallenge: false, needsTotp: false, needsPin: true, needsAdditionalPassword: false, needsWebAuthn: false, needsDeviceApproval: false, requiresPhone: Boolean(profile.phone), profile: null, email: profile.email };
      }
      if (!profile.pendingChallenge && !needsPhoneSetup && needsAdditionalPassword) {
        return { authenticated: true, needsProfile: false, needsPhoneSetup: false, needsChallenge: false, needsTotp: false, needsPin: false, needsAdditionalPassword: true, needsWebAuthn: false, needsDeviceApproval: false, requiresPhone: Boolean(profile.phone), profile: null, email: profile.email };
      }
      if (!profile.pendingChallenge && !needsPhoneSetup && needsWebAuthn) {
        return { authenticated: true, needsProfile: false, needsPhoneSetup: false, needsChallenge: false, needsTotp: false, needsPin: false, needsAdditionalPassword: false, needsWebAuthn: true, needsDeviceApproval: false, requiresPhone: Boolean(profile.phone), profile: null, email: profile.email };
      }
      if (!profile.pendingChallenge && !needsPhoneSetup && needsDeviceApproval) {
        return { authenticated: true, needsProfile: false, needsPhoneSetup: false, needsChallenge: false, needsTotp: false, needsPin: false, needsAdditionalPassword: false, needsWebAuthn: false, needsDeviceApproval: true, requiresPhone: Boolean(profile.phone), profile: null, email: profile.email };
      }
      if (!profile.pendingChallenge && !needsPhoneSetup && !needsTotp && !needsPin && !needsAdditionalPassword && !needsWebAuthn && !needsDeviceApproval) {
        await dbProfiles.updateOneSilent({ _id: profile._id }, { $set: { lastSeenAt: new Date() } });
      }

      // Every real user keeps direct chats with the two official accounts.
      if (!profile.isDecoy) await ensureServiceChats(profile.userId.toString()).catch(() => undefined);

      return {
        authenticated: true,
        needsProfile: false,
        needsPhoneSetup,
        needsChallenge: Boolean(profile.pendingChallenge),
        needsTotp,
        needsPin,
        needsAdditionalPassword,
        needsWebAuthn,
        needsDeviceApproval,
        requiresPhone: Boolean(profile.phone),
        profile: profile.pendingChallenge || needsPhoneSetup ? null : await serializeProfileWithAvatar(profile),
        email: profile.email,
      };
    },

    /** Pre-flight check before sending the OTP, so errors surface early. */
    checkSignup: async (args: unknown) => {
      const { email, username } = z
        .object({ email: z.string().email('Некорректный email'), username: z.string() })
        .parse(args);

      const parsedUsername = usernameSchema.safeParse(username);
      if (!parsedUsername.success) {
        throw new ValidationError(parsedUsername.error.issues[0].message);
      }

      const [byEmail, byUsername] = await Promise.all([
        dbProfiles.findOne({ email: email.trim().toLowerCase() }),
        dbProfiles.findOne({ usernameLower: parsedUsername.data.toLowerCase() }),
      ]);

      return {
        emailRegistered: Boolean(byEmail),
        usernameTaken: Boolean(byUsername),
      };
    },
};

export const wyreMutations = {
    ...chatMutations,
    ...callMutations,
    ...storyMutations,
    ...moderationMutations,
    ...channelMutations,
    ...settingsMutations,
    ...securityMutations,
    ...accountSecurityMutations,
    ...notificationMutations,
    ...familyMutations,
    ...serviceMutations,
    ...pushActionMutations,

    /**
     * Finishes registration right after the OTP sign-in.
     * If the email already had an account, this behaves as a login instead of
     * creating a duplicate (per the product rule "one account per email").
     */
    completeSignup: async (args: unknown, { user }: { user: UserInfo | null }) => {
      const authUser = requireUser(user);
      const { name, username } = z.object({ name: nameSchema, username: usernameSchema }).parse(args);

      const email = await primaryEmail(authUser.id);
      const existing = await findProfileByUserId(authUser.id);

      if (existing) {
        // Existing account signing in through the registration screen.
        await dbProfiles.updateOne(
          { _id: existing._id },
          { $set: { pendingChallenge: false, challengeAttempts: 0, updatedAt: new Date() } }
        );
        const refreshed = await dbProfiles.requireOne({ _id: existing._id });
        return { profile: serializeProfile(refreshed), existingAccount: true };
      }

      const taken = await dbProfiles.findOne({ usernameLower: username.toLowerCase() });
      if (taken) throw new ValidationError('Этот username уже занят');

      const now = new Date();
      const { insertedId } = await dbProfiles.insertOne({
        userId: new ObjectId(authUser.id),
        email,
        name,
        username,
        usernameLower: username.toLowerCase(),
        usernameHistory: [],
        bio: '',
        phone: null,
        colors: paletteFor(username),
        initials: initialsFrom(name),
        badge: null,
        role: env.OWNER_EMAIL && email === env.OWNER_EMAIL ? 'owner' : 'user',
        warnings: [],
        presenceVisibility: 'contacts',
        presenceAlways: [],
        presenceNever: [],
        pendingChallenge: false,
        phoneOnboardingPending: true,
        challengeAttempts: 0,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      });

      const profile = await dbProfiles.requireOne({ _id: insertedId });
      await ensureServiceChats(authUser.id).catch(() => undefined);
      return { profile: serializeProfile(profile), existingAccount: false };
    },

    /** Optional phone binding, used both at signup and later from the profile. */
    setPhone: async (args: unknown, { user }: { user: UserInfo | null }) => {
      const authUser = requireUser(user);
      const profile = await findProfileByUserId(authUser.id);
      if (!profile) throw new AuthError('Профиль не найден');
      if (profile.pendingChallenge) throw new AuthError('Сначала подтвердите вход');
      const { phone } = z.object({ phone: z.string().nullable() }).parse(args);

      if (phone === null || phone.trim() === '') {
        await dbProfiles.updateOne(
          { _id: profile._id },
          { $set: { phone: null, phoneOnboardingPending: false, updatedAt: new Date() } },
        );
        return { phone: null };
      }

      const digits = normalizePhone(phone);
      if (digits.length < 10) throw new ValidationError('Введите корректный номер телефона');

      await dbProfiles.updateOne(
        { _id: profile._id },
        { $set: { phone: digits, phoneOnboardingPending: false, updatedAt: new Date() } },
      );
      return { phone: digits };
    },

    /** Step 2 of the login flow — confirm the account's username. */
    verifyUsername: async (args: unknown, { user }: { user: UserInfo | null }) => {
      const authUser = requireUser(user);
      const { username } = z.object({ username: z.string() }).parse(args);
      const profile = await findProfileByUserId(authUser.id);
      if (!profile) throw new AuthError('Профиль не найден');

      const candidate = username.trim().replace(/^@+/, '').toLowerCase();
      if (candidate !== profile.usernameLower) {
        await registerFailedAttempt(profile);
        throw new ValidationError('Username не совпадает с этим аккаунтом');
      }

      if (!profile.phone) {
        await dbProfiles.updateOne(
          { _id: profile._id },
          { $set: { pendingChallenge: false, challengeAttempts: 0, updatedAt: new Date() } }
        );
        return { done: true, requiresPhone: false };
      }

      return { done: false, requiresPhone: true };
    },

    /** Step 3 of the login flow — confirm the phone already stored on the account. */
    verifyPhone: async (args: unknown, { user }: { user: UserInfo | null }) => {
      const authUser = requireUser(user);
      const { phone } = z.object({ phone: z.string() }).parse(args);
      const profile = await findProfileByUserId(authUser.id);
      if (!profile) throw new AuthError('Профиль не найден');
      if (!profile.phone) throw new ValidationError('К аккаунту не привязан номер');

      if (normalizePhone(phone) !== profile.phone) {
        await registerFailedAttempt(profile);
        throw new ValidationError('Номер не совпадает с привязанным к аккаунту');
      }

      await dbProfiles.updateOne(
        { _id: profile._id },
        { $set: { pendingChallenge: false, challengeAttempts: 0, updatedAt: new Date() } }
      );
      return { done: true };
    },

    updateProfile: async (args: unknown, { user }: { user: UserInfo | null }) => {
      const profile = await requireVerifiedProfile(user);
      const { name, username, bio } = z
        .object({
          name: nameSchema.optional(),
          username: usernameSchema.optional(),
          bio: z.string().max(280, 'Био не длиннее 280 символов').optional(),
        })
        .parse(args);

      const update: Record<string, unknown> = { updatedAt: new Date() };

      if (name && name !== profile.name) {
        update.name = name;
        update.initials = initialsFrom(name);
      }
      if (bio !== undefined) update.bio = bio;

      if (username && username.toLowerCase() !== profile.usernameLower) {
        const taken = await dbProfiles.findOne({ usernameLower: username.toLowerCase() });
        if (taken) throw new ValidationError('Этот username уже занят');
        update.username = username;
        update.usernameLower = username.toLowerCase();
        update.usernameHistory = [
          ...(profile.usernameHistory ?? []),
          { username: profile.username, changedAt: new Date() },
        ];
      }

      await dbProfiles.updateOne({ _id: profile._id }, { $set: update });
      const refreshed = await dbProfiles.requireOne({ _id: profile._id });
      return serializeProfileWithAvatar(refreshed);
    },

    /** Issues a signed upload ticket for the caller's own avatar. */
    requestAvatarUpload: async (args: unknown, { user }: { user: UserInfo | null }) => {
      const profile = await requireVerifiedProfile(user);
      const { fileName, fileSize, contentType } = z.object({
        fileName: z.string().trim().min(1).max(200),
        fileSize: z.number().int().positive().max(10 * 1024 * 1024, 'Аватар больше 10 МБ'),
        contentType: z.string().trim().regex(/^image\/(jpeg|png|webp|gif)$/, 'Для аватара выберите изображение'),
      }).parse(args);
      void fileSize;
      const safeName = fileName.replace(/[^\w.\-]+/g, '_').slice(-100);
      const filePath = `private/wyre-avatars/${profile.userId.toString()}/${new ObjectId().toString()}-${safeName}`;
      const upload = await getUploadUrl({ filePath, contentType });
      return { url: upload.url, fields: upload.fields, filePath };
    },

    setAvatar: async (args: unknown, { user }: { user: UserInfo | null }) => {
      const profile = await requireVerifiedProfile(user);
      const { filePath, mimeType } = z.object({
        filePath: z.string().nullable(),
        mimeType: z.string().regex(/^image\/(jpeg|png|webp|gif)$/).nullish(),
      }).parse(args);
      const ownPrefix = `private/wyre-avatars/${profile.userId.toString()}/`;
      if (filePath && !filePath.startsWith(ownPrefix)) throw new ValidationError('Некорректный файл аватара');
      if (filePath && !await storedFileExists(filePath)) throw new ValidationError('Файл аватара не найден');
      const previous = profile.avatarPath;
      await dbProfiles.updateOne({ _id: profile._id }, {
        $set: { avatarPath: filePath, avatarMimeType: filePath ? mimeType ?? 'image/jpeg' : null, updatedAt: new Date() },
      });
      // The old file is useless once replaced, so it is removed from storage.
      if (previous && previous !== filePath) await deleteStoredFile(previous);
      return serializeProfileWithAvatar(await dbProfiles.requireOne({ _id: profile._id }));
    },

    updatePresencePrivacy: async (args: unknown, { user }: { user: UserInfo | null }) => {
      const profile = await requireVerifiedProfile(user);
      const value = z.object({
        visibility: z.enum(['all', 'contacts', 'nobody']),
        always: z.array(z.string()).max(200).default([]),
        never: z.array(z.string()).max(200).default([]),
      }).parse(args);
      const always = [...new Set(value.always.filter((id) => ObjectId.isValid(id)))];
      const never = [...new Set(value.never.filter((id) => ObjectId.isValid(id)))];
      await dbProfiles.updateOne({ _id: profile._id }, {
        $set: { presenceVisibility: value.visibility, presenceAlways: always, presenceNever: never, updatedAt: new Date() },
      });
      return serializeProfileWithAvatar(await dbProfiles.requireOne({ _id: profile._id }));
    },
};
