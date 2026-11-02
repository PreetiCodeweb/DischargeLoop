import {
  CanActivate,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { validate as isUuid } from 'uuid';
import { REQUIRED_ROLES } from './roles.decorator';
import type { Actor, AuthenticatedRequest } from './auth.types';

const HOSPITAL_WIDE_ROLE = 'admin';

@Injectable()
export class OidcGuard implements CanActivate {
  private readonly issuer = process.env.OIDC_ISSUER_URL;
  private readonly jwksUrl = process.env.OIDC_JWKS_URL;
  private readonly audience = process.env.OIDC_AUDIENCE;
  private readonly jwks = this.jwksUrl ? createRemoteJWKSet(new URL(this.jwksUrl)) : undefined;

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.issuer || !this.jwks || !this.audience) {
      throw new ServiceUnavailableException('Identity provider is not configured');
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : undefined;
    if (!token) throw new UnauthorizedException('Bearer token required');

    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: this.audience }));
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }

    if (typeof payload.sub !== 'string' || !isUuid(payload.sub)) {
      throw new UnauthorizedException('Access token subject must be a UUID');
    }

    const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(realmAccess?.roles)
      ? realmAccess.roles.filter((role): role is string => typeof role === 'string')
      : [];
    const wardClaim = payload.ward_ids;
    const wardIds = Array.isArray(wardClaim)
      ? wardClaim.filter((wardId): wardId is string => typeof wardId === 'string' && isUuid(wardId))
      : [];
    const actor: Actor = { id: payload.sub, roles, wardIds };
    request.actor = actor;

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length && !required.some((role) => roles.includes(role))) {
      throw new ForbiddenException('Role is not permitted for this action');
    }
    return true;
  }
}

export function hasHospitalWideScope(actor: Actor): boolean {
  return actor.roles.includes(HOSPITAL_WIDE_ROLE) || actor.roles.includes('hospital:wide');
}
