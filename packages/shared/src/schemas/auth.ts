import { z } from 'zod';
import { passwordSchema, totpCodeSchema, usernameSchema } from './common';

export const loginRequestSchema = z.object({
  username: usernameSchema,
  // The password policy is not applied at login: existing passwords may predate it.
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const mfaVerifyRequestSchema = z.object({
  mfaToken: z.string().min(1).max(2048),
  code: totpCodeSchema,
});
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

export const mfaEnableRequestSchema = z.object({ code: totpCodeSchema });
export type MfaEnableRequest = z.infer<typeof mfaEnableRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'The new password must be different',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const updateMeRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
});
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
