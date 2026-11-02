export interface Actor {
  id: string;
  roles: string[];
  wardIds: string[];
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  actor?: Actor;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
}
