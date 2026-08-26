import { z } from 'zod';

import { type OAuthProviderId } from './auth-public';

const ExternalSchema = z
  .object({
    email: z.boolean().optional(),
    github: z.boolean().optional(),
    google: z.boolean().optional(),
    azure: z.boolean().optional(),
    apple: z.boolean().optional(),
    gitlab: z.boolean().optional(),
    bitbucket: z.boolean().optional(),
  })
  .passthrough();

const SettingsSchema = z
  .object({
    external: ExternalSchema.optional(),
    passkeys_enabled: z.boolean().optional(),
  })
  .passthrough();

export type DeskAuthMethods = {
  passkeys: boolean;
  email: boolean;
  oauth: OAuthProviderId[];
};

const ALL_OAUTH: OAuthProviderId[] = ['github', 'google', 'azure', 'apple', 'gitlab', 'bitbucket'];

function providerOn(external: z.infer<typeof ExternalSchema>, id: OAuthProviderId): boolean {
  if (id === 'github') return external.github === true;
  if (id === 'google') return external.google === true;
  if (id === 'azure') return external.azure === true;
  if (id === 'apple') return external.apple === true;
  if (id === 'gitlab') return external.gitlab === true;
  return external.bitbucket === true;
}

export type GoTrueAuthSettings = z.infer<typeof SettingsSchema>;
export const GoTrueSettingsSchema = SettingsSchema;

/** Map GoTrue `/auth/v1/settings` to the buttons the desk should show. */
export function parseDeskAuthMethods(settings: GoTrueAuthSettings, preferred: OAuthProviderId[]): DeskAuthMethods {
  const external = settings.external ?? {};
  const oauth: OAuthProviderId[] = [];
  const order = [...preferred, ...ALL_OAUTH];
  for (const id of order) {
    if (providerOn(external, id) && !oauth.includes(id)) oauth.push(id);
  }
  return {
    passkeys: settings.passkeys_enabled !== false,
    email: external.email === true,
    oauth,
  };
}

export function fallbackDeskAuthMethods(): DeskAuthMethods {
  return { passkeys: true, email: true, oauth: [] };
}
