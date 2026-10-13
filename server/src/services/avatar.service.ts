import { EntityManager, In } from 'typeorm';
import { UserAvatar } from '../entities/user-avatar.entity';
import { UserAvatarContent } from '../entities/user-avatar-content.entity';
import { AvatarPolicy } from '../entities/types';
import { AppError, unprocessable } from '../utils/errors';
import { detectImage, sha256Hex } from './kyc.service';

/**
 * Avatar storage. It follows the KYC shape (metadata row + separate BLOB row, magic-byte
 * image check) but is deliberately not immutable: an avatar is display data, so replacing
 * one overwrites the previous image instead of keeping evidence history.
 */
export function assertAvatarAllowed(policy: AvatarPolicy, buffer: Buffer): { mimeType: string } {
  if (!policy.enabled) {
    throw unprocessable('Avatars are disabled by the current system policy');
  }
  const detected = detectImage(buffer);
  if (!detected) {
    throw new AppError(415, 'Only image uploads are accepted for avatars');
  }
  if (!policy.allowedMimeTypes.includes(detected.mimeType)) {
    throw new AppError(
      415,
      `Image type ${detected.mimeType} is not allowed (allowed: ${policy.allowedMimeTypes.join(', ')})`,
    );
  }
  if (buffer.length > policy.maxFileSizeKb * 1024) {
    throw unprocessable(
      `Image is too large (${buffer.length} bytes). Current limit is ${policy.maxFileSizeKb} KB.`,
    );
  }
  return detected;
}

/** Inserts or overwrites the single avatar row of a user. */
export async function replaceAvatar(
  em: EntityManager,
  input: { userId: string; actorId: string; fileName: string; buffer: Buffer; policy: AvatarPolicy },
): Promise<UserAvatar> {
  const detected = assertAvatarAllowed(input.policy, input.buffer);
  const checksum = sha256Hex(input.buffer);

  const existing = await em.findOne(UserAvatar, { where: { userId: input.userId } });
  if (existing && existing.checksum === checksum) return existing;

  const fields = {
    fileName: input.fileName.slice(0, 255),
    mimeType: detected.mimeType,
    sizeBytes: input.buffer.length,
    checksum,
    uploadedBy: input.actorId,
  };
  const avatar = existing ?? em.create(UserAvatar, { userId: input.userId, ...fields });
  Object.assign(avatar, fields);
  await em.save(UserAvatar, avatar);
  await em.save(UserAvatarContent, em.create(UserAvatarContent, { avatarId: avatar.id, data: input.buffer }));

  return avatar;
}

export async function deleteAvatar(em: EntityManager, userId: string): Promise<boolean> {
  const avatar = await em.findOne(UserAvatar, { where: { userId } });
  if (!avatar) return false;
  await em.delete(UserAvatarContent, { avatarId: avatar.id });
  await em.delete(UserAvatar, { id: avatar.id });
  return true;
}

/** Metadata + bytes for one user, or null when the user has never uploaded an avatar. */
export async function readAvatar(
  em: EntityManager,
  userId: string,
): Promise<{ avatar: UserAvatar; data: Buffer } | null> {
  const avatar = await em.findOne(UserAvatar, { where: { userId } });
  if (!avatar) return null;
  const content = await em.findOne(UserAvatarContent, { where: { avatarId: avatar.id } });
  return content ? { avatar, data: content.data } : null;
}

/** Lightweight "which users have a picture" map for list endpoints. */
export async function avatarsByUser(
  em: EntityManager,
  userIds: string[],
): Promise<Map<string, Pick<UserAvatar, 'id' | 'mimeType' | 'sizeBytes' | 'updatedAt'>>> {
  if (userIds.length === 0) return new Map();
  const rows = await em.find(UserAvatar, { where: { userId: In(userIds) } });
  return new Map(
    rows.map((r) => [r.userId, { id: r.id, mimeType: r.mimeType, sizeBytes: r.sizeBytes, updatedAt: r.updatedAt }]),
  );
}
