import { SignJWT } from 'jose';

export const DEV_ISSUER = 'dischargeloop-dev';
export const DEV_AUDIENCE = 'dischargeloop-api';
export const DEV_SECRET = process.env.DEV_AUTH_SECRET ?? 'dischargeloop-local-dev-secret-change-me';

export const PERSONAS: Record<string, { id: string; name: string; roles: string[] }> = {
  admin: { id: '11111111-1111-7111-8111-111111111111', name: 'Alex Rivera', roles: ['admin'] },
  admission: { id: '22222222-2222-7222-8222-222222222222', name: 'Dana Okafor', roles: ['admission'] },
  clinical: { id: '33333333-3333-7333-8333-333333333333', name: 'Dr. Priya Nair', roles: ['clinical'] },
  coordinator: { id: '44444444-4444-7444-8444-444444444444', name: 'Sam Whitfield', roles: ['coordinator'] },
  housekeeping: { id: '55555555-5555-7555-8555-555555555555', name: 'Marta Silva', roles: ['housekeeping'] },
  bed_manager: { id: '66666666-6666-7666-8666-666666666666', name: 'Tom Becker', roles: ['bed_manager'] },
  pharmacy: { id: '77777777-7777-7777-8777-777777777777', name: 'Nina Patel', roles: ['pharmacy'] },
  billing: { id: '88888888-8888-7888-8888-888888888888', name: 'Omar Haddad', roles: ['billing'] },
  transport: { id: '99999999-9999-7999-8999-999999999999', name: 'Lena Brooks', roles: ['transport'] },
  auditor: { id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', name: 'Ravi Menon', roles: ['auditor'] },
};

export function isDevAuthEnabled(): boolean {
  return process.env.AUTH_MODE === 'dev';
}

export async function issueDevToken(persona: string, wardIds: string[]): Promise<{
  token: string; persona: string; actor: { id: string; name: string; roles: string[]; wardIds: string[] };
}> {
  const profile = PERSONAS[persona];
  if (!profile) throw new Error(`Unknown persona: ${persona}`);
  const token = await new SignJWT({
    realm_access: { roles: profile.roles },
    ward_ids: wardIds,
    name: profile.name,
    preferred_username: profile.name,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(profile.id)
    .setIssuer(DEV_ISSUER)
    .setAudience(DEV_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(new TextEncoder().encode(DEV_SECRET));
  return {
    token,
    persona,
    actor: { id: profile.id, name: profile.name, roles: profile.roles, wardIds },
  };
}
